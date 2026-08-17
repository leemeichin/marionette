import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  type MarionettePiContinuation,
  type MarionettePiDiscoveryRequest,
  type MarionettePiError,
  type MarionettePiEvent,
  type MarionettePiExternalConfirmation,
  type MarionettePiHostApi,
  type MarionettePiHumanAnswer,
  type MarionettePiHumanDecision,
  type MarionettePiHumanIdentityRequest,
} from './pi-integration.ts';
import { registerMarionettePlanning } from './pi-planning.ts';
import {
  PiAgentBridge,
  PiAgentBridgeError,
} from './pi-agent.ts';
import {
  ProtocolError,
  RUNTIME_PROTOCOL_VERSION,
  type ProjectionProfile,
  type RuntimeBudget,
  type RuntimePrincipal,
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
const EXTERNAL_CONFIRMATION_ENTRY = 'marionette-external-confirmation';
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

const shortLine = (value: string, limit = 180): string => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

interface HumanIdentity {
  id: string;
  uri?: string;
}

type InterventionChoice = NonNullable<RuntimeProjection['escalation']>['choices'][number];

/** Resolve the identity Git would put on a commit in this repository. */
const gitAuthorIdentity = (cwd: string): HumanIdentity | null => {
  try {
    const ident = execFileSync('git', ['var', 'GIT_AUTHOR_IDENT'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /^(.*) <([^<>]+)> \d+ [+-]\d{4}$/.exec(ident);
    if (!match?.[1]?.trim()) return null;
    return {
      id: match[1].trim(),
      ...(match[2]?.trim() ? { uri: `mailto:${match[2].trim()}` } : {}),
    };
  } catch {
    return null;
  }
};

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

const writeArtifact = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
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
    case 'awaiting-operator':
    case 'awaiting-external':
    case 'awaiting-human':
    case 'awaiting-elicitation':
      return 'Stop autonomous work and wait while the host collects human input.';
    case 'awaiting-observation':
      return 'Obtain only the requested observations, then return them through work_packet.';
    case 'waiting-timeout':
      return 'Park until the authored timeout; do not poll or take another outcome.';
    case 'stranded':
      return 'Stop and report the blocked outcomes. The work packet needs intervention.';
    case 'completed':
      return 'The managed work is complete. Report the outcome and stop.';
    case 'active':
      return 'Complete the current work packet, then return its outcome once through work_packet.';
  }
};

const choiceIdForOutcome = (
  projection: RuntimeProjection | null,
  outcome: string,
): string | null => {
  const choices = projection?.choices.filter((choice) => choice.available) ?? [];
  const normalized = outcome.trim().toLowerCase();
  const exact = choices.filter((choice) => choice.label.toLowerCase() === normalized);
  if (exact.length === 1) return exact[0]!.id;
  const prefixed = choices.filter((choice) => choice.label.toLowerCase().startsWith(normalized));
  return prefixed.length === 1 ? prefixed[0]!.id : null;
};

const agentProjection = (projection: RuntimeProjection): Record<string, unknown> => ({
  status: projection.status,
  intent: projection.plan?.intent,
  task: projection.node
    ? {
        title: projection.node.title,
        instructions: projection.node.body,
        refs: projection.node.refs,
      }
    : null,
  outcomes: projection.choices
    .filter((choice) => choice.available)
    .map((choice) => choice.label),
  automaticContinuation: Boolean(projection.next),
  observations: projection.observations,
  progress: projection.progress
    ? {
        steps: projection.progress.steps,
        completed: projection.progress.nodesVisited,
        total: projection.progress.nodesTotal,
      }
    : undefined,
});

const stepSummary = (event: MarionettePiEvent): string => {
  if (event.error) return `Marionette ${event.operation ?? 'step'} failed: ${event.error.message}`;
  const projection = event.projection;
  if (!projection) return `Marionette ${event.operation ?? 'step'} complete`;
  const progress = projection.progress
    ? ` · ${projection.progress.nodesVisited}/${projection.progress.nodesTotal}`
    : '';
  const short = (text: string): string => text.length > 160 ? `${text.slice(0, 159)}…` : text;
  const outcomes = projection.choices
    .filter((choice) => choice.available)
    .map((choice) => choice.label);
  return [
    `${projection.node?.id ?? 'workflow'} · ${projection.status}${progress}`,
    projection.node?.title ? short(projection.node.title) : '',
    outcomes.length ? short(`Outcomes: ${outcomes.join(' / ')}`) : '',
    projection.status === 'active' ? '' : instructionsFor(projection),
  ].filter(Boolean).join('\n');
};

/**
 * Tracks which Pi instances already carry the extension. Marionette ships two
 * entries (standalone and host) and a host may load either, so registration has
 * to be idempotent rather than rely on the entries loading in manifest order.
 */
const registered = new WeakMap<ExtensionAPI, { genericPlanning: boolean }>();

/** Whether {@link registerMarionetteExtension} has already run for this instance. */
export function isMarionetteExtensionRegistered(pi: ExtensionAPI): boolean {
  return registered.has(pi);
}

export function registerMarionetteExtension(
  pi: ExtensionAPI,
  { genericPlanning = true }: { genericPlanning?: boolean } = {},
): void {
  const existing = registered.get(pi);
  if (existing) {
    // A second entry resolved to the same instance. Registering again would
    // duplicate every command and leave two handlers contending over
    // setActiveTools, so keep the first registration and surface the mismatch.
    if (existing.genericPlanning !== genericPlanning) {
      console.warn(
        `[marionette] extension already registered with genericPlanning=${existing.genericPlanning}; ` +
          `ignoring a later request for genericPlanning=${genericPlanning}.`,
      );
    }
    return;
  }
  registered.set(pi, { genericPlanning });
  let bridge: PiAgentBridge | null = null;
  let lastProjection: RuntimeProjection | null = null;
  let lastCursor = 0;
  let activeContext: ExtensionContext | null = null;
  let pendingAmendment: StoredAmendment | null = null;
  let interventionTimer: ReturnType<typeof setTimeout> | undefined;
  let interventionAbort: AbortController | undefined;
  let openInterventionId = '';

  pi.registerFlag('marionette-plan', {
    description: 'Bind this Pi session to a Marionette .mar plan',
    type: 'string',
  });
  pi.registerFlag('marionette-run', {
    description: 'Runtime run id used with --marionette-plan',
    type: 'string',
  });
  pi.registerFlag('marionette-human', {
    description: 'Human identity recorded by trusted Marionette decisions (defaults to the Git author)',
    type: 'string',
  });

  const resolveHumanIdentity = async (
    ctx: ExtensionContext,
    prompt: string,
    providedId?: string,
  ): Promise<HumanIdentity | null> => {
    if (providedId?.trim()) {
      const id = providedId.trim();
      return { id, uri: `pi://human/${encodeURIComponent(id)}` };
    }
    let humanId = pi.getFlag('marionette-human');
    if (typeof humanId !== 'string') {
      pi.events.emit(MARIONETTE_PI_HUMAN_CHANNEL, {
        respond(value: string) {
          if (value.trim()) humanId = value.trim();
        },
      } satisfies MarionettePiHumanIdentityRequest);
    }
    if (typeof humanId === 'string' && humanId.trim()) {
      const id = humanId.trim();
      return { id, uri: `pi://human/${encodeURIComponent(id)}` };
    }
    const gitAuthor = gitAuthorIdentity(ctx.cwd);
    if (gitAuthor) return gitAuthor;
    if (ctx.hasUI) {
      const id = await ctx.ui.input('Your name', prompt);
      if (id?.trim()) {
        return { id: id.trim(), uri: `pi://human/${encodeURIComponent(id.trim())}` };
      }
    }
    return null;
  };

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
      clearInterventionState();
      ctx.ui.setStatus('marionette', undefined);
      ctx.ui.setWidget('marionette-escalation', undefined);
      ctx.ui.setWidget('marionette-amendment', undefined);
      return;
    }
    const phase = projection.node?.id ?? projection.status;
    ctx.ui.setStatus('marionette', `${phase} · r${projection.revision}`);
    if (projection.elicitation) {
      ctx.ui.setWidget('marionette-escalation', [
        'Workflow input needed',
        `Question: ${shortLine(projection.elicitation.question)}`,
        projection.node ? `Phase: ${shortLine(projection.node.title)}` : '',
        projection.plan?.intent.summary ? `Plan: ${shortLine(projection.plan.intent.summary)}` : '',
        'Answer in the intervention dialog.',
      ].filter(Boolean));
    } else if (projection.escalation) {
      const packet = projection.escalation;
      const heading = packet.kind === 'operator'
        ? 'Workflow decision needed'
        : packet.kind === 'external'
          ? 'Human confirmation needed'
          : 'Legacy human decision needed';
      const latest = packet.context.recentRecords.at(-1);
      const lines = [
        heading,
        projection.node ? `Phase: ${shortLine(projection.node.title)}` : '',
        packet.context.planSummary ? `Plan: ${shortLine(packet.context.planSummary)}` : '',
        `Progress: ${packet.context.progress?.nodesVisited ?? 0}/${packet.context.progress?.nodesTotal ?? 0}`,
        latest ? `Latest evidence: ${shortLine(latest.summary)}` : '',
        packet.kind === 'external'
          ? 'Choose in the dialog and provide the existing evidence URL.'
          : 'Choose in the dialog. Full details: /marionette-show',
      ].filter(Boolean);
      ctx.ui.setWidget('marionette-escalation', lines);
    } else {
      ctx.ui.setWidget('marionette-escalation', undefined);
    }
    if (pendingAmendment?.status === 'pending') {
      ctx.ui.setWidget('marionette-amendment', [
        `Marionette amendment ready (${pendingAmendment.proposal.id})`,
        `Why: ${pendingAmendment.proposal.rationale}`,
        ...pendingAmendment.proposal.report.changes.map((change) =>
          `  ${change.kind}: ${change.subject}${change.fields.length ? ` (${change.fields.join(', ')})` : ''}`),
        `Candidate: ${pendingAmendment.proposal.candidateFile}`,
        `Mermaid: ${pendingAmendment.proposal.mermaidFile}`,
        `SVG: ${pendingAmendment.proposal.svgFile}`,
        'Use /marionette-approve-amendment with a review rationale to apply it.',
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
      if (activeContext) {
        updateUi(projection, activeContext);
        syncIntervention(projection, activeContext);
      }
      planning.refreshTools();
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
      content: `${instructionsFor(event.projection)}\n\n${JSON.stringify(agentProjection(event.projection))}`,
      display: false,
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

  const executeExternal = async (
    confirmation: MarionettePiExternalConfirmation,
    cause: MarionettePiEvent['cause'],
  ): Promise<MarionettePiEvent> => {
    if (!bridge) {
      return failure(cause, new PiIntegrationError(
        'No Marionette run is bound.',
        'not-bound',
      ), 'externalConfirm');
    }
    if (confirmation.evidence.length === 0) {
      return failure(cause, new PiIntegrationError(
        'External confirmation requires durable evidence.',
        'invalid-request',
      ), 'externalConfirm');
    }
    try {
      const result = await bridge.externalConfirm(
        confirmation.external,
        confirmation.choiceId,
        confirmation.rationale,
        confirmation.evidence,
        confirmation.idempotencyKey,
        confirmation.profile,
        { budget: confirmation.budget },
      );
      const event = acceptResult('externalConfirm', result, cause);
      pi.appendEntry(EXTERNAL_CONFIRMATION_ENTRY, {
        choiceId: confirmation.choiceId,
        external: confirmation.external,
        rationale: confirmation.rationale,
        evidence: confirmation.evidence,
        revision: event.projection?.revision,
        eventSeqs: event.receipt?.eventSeqs ?? [],
      });
      publishProjection(event, confirmation.triggerTurn ?? true);
      return event;
    } catch (error) {
      return failure(cause, error, 'externalConfirm');
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

  function clearInterventionDialog(): void {
    interventionAbort?.abort();
    interventionAbort = undefined;
    openInterventionId = '';
  }

  function clearInterventionState(): void {
    if (interventionTimer) clearTimeout(interventionTimer);
    interventionTimer = undefined;
    clearInterventionDialog();
  }

  function choiceDisplay(choice: InterventionChoice): string {
    const label = /^request (?:verified )?changes[.!]?$/i.test(choice.label.trim())
      ? 'Return for changes'
      : choice.label;
    const target = choice.targetTitle ?? choice.target?.replace(/_/g, ' ');
    const consequence = choice.target === 'END' ? 'finish the workflow' : target ? `continue to ${target}` : '';
    return `${label}${consequence ? ` — ${consequence}` : ''}`;
  }

  function choiceFromAnswer(projection: RuntimeProjection, answer: string): InterventionChoice | undefined {
    const choices = projection.escalation?.choices ?? [];
    const normalized = answer.trim().toLocaleLowerCase();
    if (/^[1-9]\d*$/.test(normalized)) return choices[Number(normalized) - 1];
    return choices.find((choice) =>
      [choice.label, choiceDisplay(choice)].some((candidate) => candidate.toLocaleLowerCase() === normalized)
    );
  }

  function interventionPrompt(projection: RuntimeProjection, question: string): string {
    const context = projection.escalation?.context;
    const progress = context?.progress ?? projection.progress;
    const body = context?.phaseBody ?? projection.node?.body;
    const latest = context?.recentRecords.at(-1);
    return [
      question,
      projection.node
        ? `Phase: ${shortLine(projection.node.title)}${progress ? ` (${progress.nodesVisited}/${progress.nodesTotal})` : ''}`
        : '',
      context?.planSummary
        ? `Plan: ${shortLine(context.planSummary)}`
        : context?.planPrompt
          ? `Request: ${shortLine(context.planPrompt)}`
          : '',
      body && body !== projection.node?.title ? `Context: ${shortLine(body)}` : '',
      latest ? `Latest evidence: ${shortLine(latest.summary)}` : '',
    ].filter(Boolean).join('\n');
  }

  async function trustedHuman(ctx: ExtensionContext): Promise<HumanIdentity | null> {
    const human = await resolveHumanIdentity(ctx, 'recorded as the workflow participant');
    if (!human) {
      ctx.ui.notify('Configure a Git author or set --marionette-human <name> for trusted decisions.', 'error');
    }
    return human;
  }

  async function applyInteractiveResponse(
    projection: RuntimeProjection,
    answer: string,
    interactionId: string,
    ctx: ExtensionContext,
  ): Promise<'applied' | 'unmatched' | 'ignored'> {
    if (!bridge || !answer.trim()) return 'ignored';
    if (projection.status === 'awaiting-elicitation' && projection.elicitation) {
      const human = await trustedHuman(ctx);
      if (!human) return 'applied';
      const event = await executeHumanAnswer({
        human,
        answer: answer.trim(),
        idempotencyKey: `interaction:${interactionId}:answer`,
        triggerTurn: true,
      }, { source: 'host', name: 'intervention:answer' });
      if (event.error) ctx.ui.notify(event.error.message, 'error');
      return 'applied';
    }
    if (['awaiting-operator', 'awaiting-human'].includes(projection.status) && projection.escalation) {
      const choice = choiceFromAnswer(projection, answer);
      if (!choice) return 'unmatched';
      const human = await trustedHuman(ctx);
      if (!human) return 'applied';
      const event = await executeHuman({
        human,
        choiceId: choice.id,
        rationale: `Selected “${choice.label}” through Pi's interactive workflow UI.`,
        idempotencyKey: `interaction:${interactionId}:${choice.id}`,
        triggerTurn: true,
      }, { source: 'host', name: 'intervention:choose' });
      if (event.error) ctx.ui.notify(event.error.message, 'error');
      return 'applied';
    }
    return 'ignored';
  }

  async function leaveWorkflow(projection: RuntimeProjection, ctx: ExtensionContext): Promise<void> {
    const confirmed = await ctx.ui.confirm(
      'Leave managed workflow?',
      `${projection.node?.title ?? projection.node?.id ?? 'This workflow'} will stop controlling this session. Its recorded progress is kept and can be resumed later.`,
    );
    if (!confirmed) return;
    const event = await hostApi.unbind();
    if (event.error) ctx.ui.notify(event.error.message, 'error');
  }

  async function openIntervention(projection: RuntimeProjection, ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || !bridge) return;
    const id = projection.escalation?.id ?? projection.elicitation?.id ??
      (projection.status === 'stranded' ? `stranded:${projection.runId}:${projection.revision}` : undefined);
    if (!id || openInterventionId === id) return;
    clearInterventionDialog();
    openInterventionId = id;
    const controller = new AbortController();
    interventionAbort = controller;
    const leave = 'Leave managed workflow…';
    try {
      if (projection.status === 'stranded') {
        const repair = 'Repair workflow future…';
        const selected = await ctx.ui.select(
          interventionPrompt(
            projection,
            'No graph route is available. Repair the unfinished future, keep the run bound, or leave managed execution.',
          ),
          [repair, 'Keep workflow bound', leave],
          { signal: controller.signal },
        );
        if (selected === repair) {
          pi.sendUserMessage(
            'The bound Marionette workflow is stranded. Inspect its .mar source and call marionette_amend with a complete compiler-checked correction to the unfinished future and a concise rationale. Preserve completed phase ids and history; do not wait for a separate approval or rebind.',
            { deliverAs: 'followUp' },
          );
        } else if (selected === leave) {
          await leaveWorkflow(projection, ctx);
        }
        return;
      }
      if (projection.status === 'awaiting-elicitation' && projection.elicitation) {
        const answer = (await ctx.ui.editor(
          interventionPrompt(projection, projection.elicitation.question),
          '',
        ))?.trim();
        if (answer) await applyInteractiveResponse(projection, answer, `dialog:${id}`, ctx);
        return;
      }
      const escalation = projection.escalation;
      if (!escalation) return;
      const displays = escalation.choices.map(choiceDisplay);
      const question = projection.status === 'awaiting-external'
        ? 'Which completed action are you confirming?'
        : 'What should happen next?';
      const selected = await ctx.ui.select(
        interventionPrompt(projection, question),
        [...displays, leave],
        { signal: controller.signal },
      );
      if (selected === leave) {
        await leaveWorkflow(projection, ctx);
        return;
      }
      const choice = escalation.choices[displays.indexOf(selected ?? '')];
      if (!choice) return;
      const human = await trustedHuman(ctx);
      if (!human) return;
      if (projection.status === 'awaiting-external') {
        const evidenceUrl = (await ctx.ui.input(
          `Evidence URL for “${choice.label}”`,
          'https://…',
          { signal: controller.signal },
        ))?.trim();
        if (!evidenceUrl || !/^https?:\/\//.test(evidenceUrl)) {
          if (evidenceUrl) ctx.ui.notify('A high-risk confirmation needs an HTTP(S) evidence URL.', 'error');
          return;
        }
        const event = await executeExternal({
          external: human,
          choiceId: choice.id,
          rationale: `Confirmed “${choice.label}” through Pi's interactive workflow UI.`,
          evidence: [{ provider: 'url', kind: 'evidence', id: evidenceUrl, url: evidenceUrl }],
          idempotencyKey: `dialog:${id}:${choice.id}:${evidenceUrl}`,
          triggerTurn: true,
        }, { source: 'host', name: 'intervention:confirm' });
        if (event.error) ctx.ui.notify(event.error.message, 'error');
      } else {
        const event = await executeHuman({
          human,
          choiceId: choice.id,
          rationale: `Selected “${choice.label}” through Pi's interactive workflow UI.`,
          idempotencyKey: `dialog:${id}:${choice.id}`,
          triggerTurn: true,
        }, { source: 'host', name: 'intervention:choose' });
        if (event.error) ctx.ui.notify(event.error.message, 'error');
      }
    } catch (error) {
      if (!controller.signal.aborted) ctx.ui.notify(`Workflow intervention failed: ${(error as Error).message}`, 'error');
    } finally {
      if (interventionAbort === controller) {
        interventionAbort = undefined;
        openInterventionId = '';
      }
    }
  }

  function syncIntervention(projection: RuntimeProjection, ctx: ExtensionContext): void {
    if (!genericPlanning) {
      clearInterventionState();
      return;
    }
    if (interventionTimer) clearTimeout(interventionTimer);
    interventionTimer = undefined;
    if (projection.status === 'waiting-timeout') {
      const dueAt = [
        ...projection.choices.map((choice) => choice.dueAt),
        ...(projection.escalation?.fallbacks.map((fallback) => fallback.dueAt) ?? []),
      ].filter((value): value is string => Boolean(value)).sort()[0];
      if (dueAt) {
        const delay = Math.min(Math.max(0, new Date(dueAt).getTime() - Date.now()), 2_147_000_000);
        interventionTimer = setTimeout(() => {
          interventionTimer = undefined;
          ctx.ui.notify('Marionette timeout is due; resuming the workflow.', 'info');
          void executeAgent(
            { operation: 'next' },
            { source: 'session', name: `timeout:${dueAt}` },
          ).then((event) => {
            if (event.error) ctx.ui.notify(event.error.message, 'error');
            else publishProjection(event, true);
          });
        }, delay);
        interventionTimer.unref();
      }
    }
    if (
      projection.status === 'awaiting-operator' || projection.status === 'awaiting-external' ||
      projection.status === 'awaiting-human' || projection.status === 'awaiting-elicitation' ||
      projection.status === 'stranded'
    ) {
      void openIntervention(projection, ctx);
    } else {
      clearInterventionDialog();
    }
  }

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

  const applyAmendment = async (
    stored: StoredAmendment,
    principal: RuntimePrincipal,
    rationale: string,
    cause: MarionettePiEvent['cause'],
    operation: 'amend' | 'humanAmend',
    triggerTurn: boolean,
  ): Promise<MarionettePiEvent> => {
    if (!bridge) {
      return failure(cause, new PiIntegrationError('No Marionette run is bound.', 'not-bound'), operation);
    }
    try {
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
          result = await bridge!.amend(principal, compiled.trajectory!, rationale);
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
      const event = acceptResult(operation, result!, cause, 'plan.rebound', stored.proposal);
      if (activeContext) updateUi(event.projection ?? null, activeContext);
      if (triggerTurn) publishProjection(event, true);
      return event;
    } catch (error) {
      return failure(cause, error, operation);
    }
  };

  const approveAmendment = async (
    approval: MarionettePiAmendmentApproval,
    cause: MarionettePiEvent['cause'],
  ): Promise<MarionettePiEvent> => {
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
    return applyAmendment(
      pendingAmendment,
      { ...approval.human, role: 'human' },
      approval.rationale,
      cause,
      'humanAmend',
      approval.triggerTurn ?? true,
    );
  };

  const open = async (
    binding: StoredBinding,
    ctx: ExtensionContext,
    cause: MarionettePiEvent['cause'],
    persistBinding: boolean,
    runMode: 'open-or-create' | 'open' | 'create' = 'open-or-create',
    continuation?: MarionettePiContinuation,
  ): Promise<MarionettePiEvent> => {
    const candidate = await PiAgentBridge.open({
      planFile: binding.planFile,
      runId: binding.runId,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      runMode,
    });
    const result = await candidate.next();
    const projection = projectionOf(result);
    if (!projection) throw new Error('Marionette runtime returned no projection');
    bridge = candidate;
    lastProjection = projection;
    lastCursor = projection.cursor;
    updateUi(projection, ctx);
    syncIntervention(projection, ctx);
    planning.refreshTools();
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
      operation: continuation?.kind,
      continuation,
    });
  };

  const requireCompletedBinding = async (): Promise<MarionettePiBinding> => {
    if (!bridge) {
      throw new PiIntegrationError('No Marionette run is bound.', 'not-bound');
    }
    await bridge.refresh();
    if (bridge.currentState().status !== 'completed') {
      throw new PiIntegrationError(
        'Rebind and extend are available only after the bound run completes.',
        'invalid-request',
      );
    }
    return currentBinding()!;
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
    planning.refreshTools();
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

  let hostApi: MarionettePiHostApi;
  const planning = registerMarionettePlanning(pi, {
    getBinding: currentBinding,
    isCompleted: () => lastProjection?.status === 'completed',
    bind: (request) => hostApi.bind(request),
    execute: (command) => hostApi.execute(command as MarionettePiAgentCommand),
    onEvent: (event) => {
      if (event.error && activeContext) activeContext.ui.notify(event.error.message, 'error');
    },
  }, { genericSurface: genericPlanning });

  hostApi = {
    protocol: MARIONETTE_PI_INTEGRATION_VERSION,
    getBinding: currentBinding,
    getDraft: planning.getDraft,
    getExecution: planning.getExecution,
    startDraft: planning.startDraft,
    showDraft: (ctx) => planning.show(ctx),
    approveDraft: (request, ctx) => planning.approve(request, ctx),
    refineDraft: (request, ctx) => planning.refine(request.feedback, ctx),
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
    resolveHumanIdentity: async () =>
      activeContext ? resolveHumanIdentity(activeContext, 'recorded as the workflow participant') : null,
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
    externalConfirm: (confirmation) => executeExternal(confirmation, {
      source: 'host',
      name: 'externalConfirm',
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
      const human = await resolveHumanIdentity(ctx, 'recorded as the amendment approver');
      if (!human) {
        ctx.ui.notify('Configure a Git author, set --marionette-human <name>, or provide a name through the host.', 'error');
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
        human,
        proposalId,
        rationale,
        triggerTurn: true,
      }, { source: 'command', name: 'marionette-approve-amendment' });
      if (event.error) ctx.ui.notify(event.error.message, 'error');
    },
  });

  pi.registerCommand('marionette-decide', {
    description: 'Record the trusted operator choice at an @ask checkpoint',
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
      if (escalation.kind === 'external') {
        ctx.ui.notify(
          'This checkpoint requires evidenced human confirmation. Use /marionette-confirm-human.',
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

      const human = await resolveHumanIdentity(ctx, 'recorded as the decision actor');
      if (!human) {
        ctx.ui.notify('Configure a Git author, set --marionette-human <name>, or provide a name through the host.', 'error');
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
        human,
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

  pi.registerCommand('marionette-confirm-human', {
    description: 'Record an evidenced human confirmation for an @human action',
    handler: async (args, ctx) => {
      activeContext = ctx;
      const refresh = await executeAgent(
        { operation: 'next' },
        { source: 'command', name: 'marionette-confirm-human:refresh' },
      );
      const escalation = refresh.projection?.escalation;
      if (refresh.error || !escalation || escalation.kind !== 'external') {
        ctx.ui.notify(
          refresh.error?.message ?? 'No evidenced human confirmation is currently pending.',
          'error',
        );
        return;
      }
      const [choiceId, ...confirmationArgs] = splitArgs(args);
      const choice = escalation.choices.find((candidate) => candidate.id === choiceId);
      if (!choice) {
        ctx.ui.notify(`Choose one of: ${escalation.choices.map((item) => item.id).join(', ')}`, 'error');
        return;
      }
      // Current syntax is `<choice> <evidence-url> [rationale]`. Accept the
      // former explicit-name position so existing host scripts keep working.
      const suppliedId = /^https?:\/\//.test(confirmationArgs[0] ?? '')
        ? undefined
        : confirmationArgs.shift();
      const evidenceUrl = confirmationArgs.shift();
      if (!evidenceUrl || !/^https?:\/\//.test(evidenceUrl)) {
        ctx.ui.notify('Provide a durable http(s) evidence URL.', 'error');
        return;
      }
      const human = await resolveHumanIdentity(
        ctx,
        'recorded as the human confirming this action',
        suppliedId,
      );
      if (!human) {
        ctx.ui.notify('Configure a Git author, set --marionette-human <name>, or provide a name through the host.', 'error');
        return;
      }
      let rationale = confirmationArgs.join(' ').trim();
      if (!rationale && ctx.hasUI) {
        rationale = (await ctx.ui.editor('What action is being confirmed?', '') ?? '').trim();
      }
      if (!rationale) {
        ctx.ui.notify('An evidence rationale is required.', 'error');
        return;
      }
      const event = await executeExternal({
        external: human,
        choiceId: choice.id,
        rationale,
        evidence: [{ provider: 'url', kind: 'evidence', id: evidenceUrl, url: evidenceUrl }],
        idempotencyKey: `external:${escalation.id}:${choice.id}:${evidenceUrl}`,
        triggerTurn: true,
      }, { source: 'command', name: 'marionette-confirm-human' });
      if (event.error) ctx.ui.notify(event.error.message, 'error');
    },
  });

  pi.registerCommand('marionette-answer', {
    description: 'Supply context for an open @input checkpoint',
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

      const human = await resolveHumanIdentity(ctx, 'recorded as the answer source');
      if (!human) {
        ctx.ui.notify('Configure a Git author, set --marionette-human <name>, or provide a name through the host.', 'error');
        return;
      }

      const event = await executeHumanAnswer({
        human,
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
    label: 'Marionette amendment',
    description:
      'Compile and atomically apply a future-only amendment to the bound run. Completed phases remain immutable; accepted changes update the live source and runtime graph with an attributed plan.rebound event.',
    parameters: Type.Object({
      source: Type.String({ description: 'Complete candidate Marionette DSL source' }),
      rationale: Type.String({ description: 'Why the current executable future needs to change' }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const cause = {
        source: 'tool' as const,
        name: 'marionette_amend',
        id: toolCallId,
      };
      const proposed = await proposeAmendment(params, cause);
      if (proposed.error || !proposed.amendment || !pendingAmendment || !bridge) {
        return {
          content: [{ type: 'text', text: proposed.error?.message ?? 'Amendment proposal failed.' }],
          details: proposed,
          isError: true,
        };
      }
      const event = await applyAmendment(
        pendingAmendment,
        bridge.agentPrincipal,
        params.rationale,
        cause,
        'amend',
        false,
      );
      if (event.error || !event.amendment) {
        return {
          content: [{ type: 'text', text: event.error?.message ?? 'Amendment application failed.' }],
          details: event,
          isError: true,
        };
      }
      const amendment = event.amendment;
      const changes = amendment.report.changes.map((change) =>
        `- ${change.kind}: ${change.subject}${change.fields.length ? ` (${change.fields.join(', ')})` : ''}`,
      ).join('\n');
      return {
        content: [{
          type: 'text',
          text: [
            `Amendment ${amendment.id} was validated and applied.`,
            `Live plan updated: ${amendment.planFile}`,
            '',
            changes || '- no semantic changes',
            '',
            amendment.compact,
            '',
            `Candidate: ${amendment.candidateFile}`,
            `Mermaid: ${amendment.mermaidFile}`,
            `SVG: ${amendment.svgFile}`,
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
    name: 'marionette_rebind',
    label: 'Marionette rebind',
    description:
      'After the bound run completes, switch this Pi session to an existing validated Marionette plan and run without changing completed history.',
    promptSnippet: 'Rebind a completed managed session to an existing Marionette plan/run',
    promptGuidelines: [
      'Use marionette_rebind only when post-completion work already has a validated plan and existing run id.',
    ],
    parameters: Type.Object({
      planFile: Type.String({ description: 'Existing .mar plan path, relative to the Pi working directory or absolute' }),
      runId: Type.String({ description: 'Existing runtime run id to resume' }),
      rationale: Type.String({ description: 'Why this completed session should switch to that run' }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const cause = { source: 'tool' as const, name: 'marionette_rebind', id: toolCallId };
      try {
        const previous = await requireCompletedBinding();
        if (!params.rationale.trim()) {
          throw new PiIntegrationError('Rebind requires a rationale.', 'invalid-request');
        }
        const event = await open(
          { planFile: params.planFile, runId: params.runId },
          ctx,
          cause,
          true,
          'open',
          { kind: 'rebind', previous, rationale: params.rationale },
        );
        return {
          content: [{
            type: 'text',
            text: `Rebound to ${event.binding!.planFile} (${event.binding!.runId}).\n${JSON.stringify(agentProjection(event.projection!))}`,
          }],
          details: event,
        };
      } catch (error) {
        const event = failure(cause, error);
        return {
          content: [{ type: 'text', text: event.error!.message }],
          details: event,
          isError: true,
        };
      }
    },
    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('marionette rebind')), 0, 0);
    },
  });

  pi.registerTool({
    name: 'marionette_extend',
    label: 'Marionette extend',
    description:
      'After the bound run completes, validate and atomically write a successor .mar plan, create a fresh run, and bind this Pi session to the additional managed work.',
    promptSnippet: 'Extend a completed managed session with a validated successor plan/run',
    promptGuidelines: [
      'Use marionette_extend for additional work after completion; provide a complete successor plan and never rewrite the completed plan.',
    ],
    parameters: Type.Object({
      path: Type.String({ description: 'New successor .mar path, relative to the Pi working directory or absolute' }),
      source: Type.String({ description: 'Complete successor Marionette DSL source for the additional work' }),
      rationale: Type.String({ description: 'Why this successor work extends the completed session' }),
      runId: Type.Optional(Type.String({ description: 'Fresh runtime run id; defaults to a tool-call-specific continuation id' })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const cause = { source: 'tool' as const, name: 'marionette_extend', id: toolCallId };
      try {
        const previous = await requireCompletedBinding();
        if (!params.rationale.trim()) {
          throw new PiIntegrationError('Extend requires a rationale.', 'invalid-request');
        }
        const planFile = resolve(ctx.cwd, params.path);
        if (extname(planFile) !== '.mar') {
          throw new PiIntegrationError('Successor plan path must end in .mar.', 'invalid-request');
        }
        const compiled = await compile(params.source, { file: planFile });
        if (!compiled.ok || !compiled.trajectory) {
          throw new PiIntegrationError(
            formatDiagnostics(compiled.diagnostics, planFile, { source: params.source }) ||
              'Successor plan did not produce a trajectory.',
            'invalid-request',
          );
        }
        const runId = params.runId?.trim() ||
          safeRunId(`${previous.runId}-continuation-${toolCallId}`);
        await withFileMutationQueue(planFile, () => writePlan(planFile, params.source, false));
        const event = await open(
          { planFile, runId },
          ctx,
          cause,
          true,
          'create',
          { kind: 'extend', previous, rationale: params.rationale },
        );
        return {
          content: [{
            type: 'text',
            text: [
              `Successor plan validated and bound: ${event.binding!.planFile} (${event.binding!.runId}).`,
              renderCompactGraph(compiled.trajectory),
              JSON.stringify(agentProjection(event.projection!)),
            ].join('\n\n'),
          }],
          details: event,
        };
      } catch (error) {
        const event = failure(cause, error);
        return {
          content: [{ type: 'text', text: event.error!.message }],
          details: event,
          isError: true,
        };
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('marionette extend ')) +
          theme.fg('muted', args.path),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: 'marionette_draft',
    label: 'Marionette draft',
    description:
      'Validate and atomically write a Marionette .mar plan. Invalid plans are not written; valid plans are shown immediately and return compiler diagnostics, summary, compact graph, graph hash, and Mermaid/SVG resource paths for out-of-band rendering.',
    promptSnippet: 'Validate and atomically write a complete Marionette workflow draft',
    promptGuidelines: [
      'Use marionette_draft to write the .mar source while Marionette draft mode is active; built-in project write tools remain disabled.',
    ],
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
      const compact = renderCompactGraph(compiled.trajectory);
      const mermaid = await renderMermaid(compiled.trajectory);
      const svg = await renderSvg(compiled.trajectory);
      const mermaidFile = planFile.replace(/\.mar$/, '.mmd');
      const svgFile = planFile.replace(/\.mar$/, '.svg');
      await withFileMutationQueue(planFile, () =>
        writePlan(planFile, params.source, params.overwrite === true));
      await Promise.all([
        withFileMutationQueue(mermaidFile, () => writeArtifact(mermaidFile, mermaid)),
        withFileMutationQueue(svgFile, () => writeArtifact(svgFile, svg)),
      ]);
      const resource = (path: string, mediaType: string) => ({
        path,
        uri: pathToFileURL(path).href,
        mediaType,
      });
      const project = compiled.trajectory.meta['project'];
      const draft = {
        planFile,
        graphHash: compiled.trajectory.hash,
        name: typeof project === 'string' ? project : undefined,
        summary,
        compact,
        mermaid,
        resources: {
          plan: resource(planFile, 'text/plain'),
          mermaid: resource(mermaidFile, 'text/vnd.mermaid'),
          svg: resource(svgFile, 'image/svg+xml'),
        },
        warnings: compiled.diagnostics.filter((item) => item.severity === 'warning').length,
      };
      planning.acceptDraft(draft, ctx);
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
        content: [{
          type: 'text',
          text: `${summary}\n\nCompact graph:\n${compact}\n\nSVG graph: ${svgFile}\nMermaid source: ${mermaidFile}`,
        }],
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
        compact?: string;
        mermaid?: string;
        resources?: { svg?: { path?: string } };
        diagnostics?: unknown[];
      } | undefined;
      if (!details?.ok) {
        return new Text(theme.fg('error', 'Plan rejected by the compiler; no file written.'), 0, 0);
      }
      const base = `${theme.fg('success', '✓ Valid plan — ready for review')} ${theme.fg('muted', details.planFile ?? '')}`;
      const compact = details.compact ? `\n${details.compact}` : '';
      const artifact = details.resources?.svg?.path
        ? `\n${theme.fg('accent', 'SVG')} ${theme.fg('muted', details.resources.svg.path)}`
        : '';
      return new Text(
        expanded
          ? `${base}${compact}${artifact}\n\n${details.summary ?? ''}\n\n${theme.fg('dim', details.mermaid ?? '')}`
          : `${base}${compact}${artifact}`,
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
    name: 'work_packet',
    label: 'Work packet',
    description:
      'Read the current managed task, return one completed outcome, request authored input, record observations, or attach evidence. Human intervention is handled by the host.',
    promptSnippet: 'Read or complete the current managed work packet',
    promptGuidelines: [
      'Use work_packet with operation=status to read the current task.',
      'After completing a task, call work_packet exactly once with operation=complete, the human-readable outcome label when choices exist, and an evidence-based summary.',
      'When work_packet says human input is pending, stop; the host opens the intervention UI automatically.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('status'),
        Type.Literal('complete'),
        Type.Literal('request_input'),
        Type.Literal('observe'),
        Type.Literal('record'),
      ]),
      outcome: Type.Optional(Type.String({ description: 'Human-readable outcome label; internal ids are never needed' })),
      question: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
      summary: Type.Optional(Type.String()),
      rationale: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(refSchema)),
      recordKind: Type.Optional(Type.String()),
      refs: Type.Optional(Type.Array(refSchema)),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const cause = { source: 'tool' as const, name: 'work_packet', id: toolCallId };
      let command: MarionettePiAgentCommand;
      if (params.operation === 'status') {
        command = { operation: 'next', profile: 'work' };
      } else if (params.operation === 'complete') {
        if (!params.summary) {
          const event = failure(cause, new PiIntegrationError(
            'complete requires an evidence-based summary',
            'invalid-request',
          ));
          return { content: [{ type: 'text', text: event.error!.message }], details: event, isError: true };
        }
        if (params.outcome) {
          const choiceId = choiceIdForOutcome(lastProjection, params.outcome);
          if (!choiceId) {
            const event = failure(cause, new PiIntegrationError(
              `No unique available outcome matches “${params.outcome}”`,
              'invalid-request',
            ));
            return { content: [{ type: 'text', text: event.error!.message }], details: event, isError: true };
          }
          command = {
            operation: 'choose',
            choiceId,
            rationale: params.summary,
            idempotencyKey: toolCallId,
            profile: 'work',
            evidence: refsOf(params.evidence),
          };
        } else {
          command = {
            operation: 'advance',
            rationale: params.summary,
            idempotencyKey: toolCallId,
            profile: 'work',
            evidence: refsOf(params.evidence),
          };
        }
      } else if (params.operation === 'request_input') {
        if (!params.outcome || !params.question || !params.summary) {
          const event = failure(cause, new PiIntegrationError(
            'request_input requires outcome, question, and summary',
            'invalid-request',
          ));
          return { content: [{ type: 'text', text: event.error!.message }], details: event, isError: true };
        }
        const choiceId = choiceIdForOutcome(lastProjection, params.outcome);
        if (!choiceId) {
          const event = failure(cause, new PiIntegrationError(
            `No unique available outcome matches “${params.outcome}”`,
            'invalid-request',
          ));
          return { content: [{ type: 'text', text: event.error!.message }], details: event, isError: true };
        }
        command = {
          operation: 'ask',
          choiceId,
          question: params.question,
          rationale: params.summary,
          idempotencyKey: toolCallId,
          profile: 'work',
          evidence: refsOf(params.evidence),
        };
      } else if (params.operation === 'observe') {
        if (!params.name || params.value === undefined || !params.summary) {
          const event = failure(cause, new PiIntegrationError(
            'observe requires name, value, and summary',
            'invalid-request',
          ));
          return { content: [{ type: 'text', text: event.error!.message }], details: event, isError: true };
        }
        command = {
          operation: 'observe',
          name: params.name,
          value: params.value as Value,
          rationale: params.summary,
          idempotencyKey: toolCallId,
          profile: 'work',
          evidence: refsOf(params.evidence),
        };
      } else {
        if (!params.recordKind || !params.summary) {
          const event = failure(cause, new PiIntegrationError(
            'record requires recordKind and summary',
            'invalid-request',
          ));
          return { content: [{ type: 'text', text: event.error!.message }], details: event, isError: true };
        }
        command = {
          operation: 'record',
          kind: params.recordKind,
          summary: params.summary,
          rationale: params.rationale,
          refs: refsOf(params.refs),
          idempotencyKey: toolCallId,
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
      const payload = event.projection ? agentProjection(event.projection) : event.result ?? {};
      const stop = event.projection && event.projection.status !== 'active'
        ? `\n${instructionsFor(event.projection)}`
        : '';
      return {
        content: [{ type: 'text', text: `${JSON.stringify(payload)}${stop}` }],
        details: event,
      };
    },
    renderResult(result) {
      return new Text(stepSummary(result.details as MarionettePiEvent), 0, 0);
    },
  });

  pi.registerTool({
    name: 'marionette_walk',
    label: 'Marionette walk',
    description:
      'Read or advance the bound Marionette run, attach records, or inspect its event journal. ' +
      'The tool is agent-bound: it cannot choose operator @ask routes or provide evidenced @human confirmation, and opens @input with a focused question.',
    promptSnippet: 'marionette_walk — authoritative work packet and traversal for the bound Marionette run',
    promptGuidelines: [
      'When marionette_walk is bound, use it instead of marionette brief or marionette state commands.',
      'After each phase, call marionette_walk exactly once with choose or advance and an evidence-based rationale.',
      'At awaiting-operator, awaiting-external, awaiting-elicitation, waiting-timeout, stranded, or completed status, stop autonomous traversal and follow the projection.',
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
        ['awaiting-operator', 'awaiting-external', 'awaiting-human', 'awaiting-elicitation', 'waiting-timeout', 'stranded', 'completed']
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
    renderResult(result) {
      return new Text(stepSummary(result.details as MarionettePiEvent), 0, 0);
    },
  });

  pi.on('input', async (event, ctx) => {
    if (!genericPlanning || event.source !== 'interactive' || event.text.startsWith('/') || !lastProjection) return;
    const result = await applyInteractiveResponse(
      lastProjection,
      event.text,
      `session:${ctx.sessionManager.getSessionId()}:${lastProjection.revision}`,
      ctx,
    );
    if (result === 'unmatched') {
      ctx.ui.notify(
        `Choose one of: ${lastProjection.escalation?.choices.map((choice) => choice.label).join(', ') ?? 'the available outcomes'}.`,
        'warning',
      );
    }
    if (result !== 'ignored') return { action: 'handled' as const };
    return undefined;
  });

  pi.on('session_start', async (event, ctx) => {
    await restore(ctx, {
      source: 'session',
      name: `session_start:${event.reason}`,
    });
    planning.sessionStart(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    await restore(ctx, {
      source: 'session',
      name: 'session_tree',
    });
    planning.sessionTree(ctx);
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
    planning.shutdown();
    clearInterventionState();
    activeContext = null;
    bridge = null;
    lastProjection = null;
    lastCursor = 0;
    unsubscribeDiscovery();
  });
}

export default function marionetteExtension(pi: ExtensionAPI): void {
  registerMarionetteExtension(pi);
}
