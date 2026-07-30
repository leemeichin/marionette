/**
 * Immutable, asynchronous traversal facade over the normative Prolog walker.
 *
 * Prolog owns availability, refusal precedence and semantic transitions.
 * TypeScript owns trajectory binding, timestamps, audit records and persisted
 * state shape.
 */

import type {
  Choice,
  PlanState,
  Ref,
  Trajectory,
  TrajectoryNode,
  Value,
} from './types.ts';
import { END, PLAN_STATE_VERSION } from './types.ts';
import { analyzeAmendment, type AmendmentReport } from './amendment.ts';
import {
  interactionKind, isExternalHumanChoice, isInputChoice,
} from './gates.ts';
import { emitFacts } from './facts.ts';
import { blockedText, refusalText } from './diagnostics.ts';
import {
  ruleWalkApply,
  ruleWalkFrontier,
  ruleWalkInit,
  type RuleFrontierItem,
  type RuleSemanticState,
  type RuleWalkResult,
} from './rule-engine.ts';

export class DriftError extends Error {
  constructor(public readonly stateHash: string, public readonly planHash: string) {
    super(
      'plan/state drift detected: the script changed since this state was recorded.\n' +
      `  state is bound to  ${stateHash}\n` +
      `  compiled plan is   ${planHash}\n` +
      'Reconcile before continuing: review the plan changes, then either re-initialise the state ' +
      '(marionette state init --force) or restore the previous script version.',
    );
    this.name = 'DriftError';
  }
}

export type WalkErrorCode =
  | 'completed'
  | 'unknown-node'
  | 'unknown-choice'
  | 'ambiguous-choice'
  | 'gate-blocked'
  | 'observation-required'
  | 'unknown-observation'
  | 'observation-type'
  | 'timeout-pending'
  | 'timed-out'
  | 'once-exhausted'
  | 'human-checkpoint'
  | 'elicitation-required'
  | 'elicitation-pending'
  | 'operator-checkpoint'
  | 'external-confirmation-required'
  | 'external-evidence-required'
  | 'rationale-required'
  | 'no-next-step'
  | 'migration-blocked'
  | 'invalid-state';

export class WalkError extends Error {
  constructor(message: string, public readonly code: WalkErrorCode) {
    super(message);
    this.name = 'WalkError';
  }
}

export interface AvailableChoice {
  choice: Choice;
  blocked: string | null;
  blockedCode:
    | 'once-exhausted'
    | 'gate-blocked'
    | 'observation-required'
    | 'elicitation-pending'
    | 'timeout-pending'
    | 'timed-out'
    | null;
}

export interface TakeOptions {
  actor: string;
  rationale?: string;
  at?: string;
}

export interface ObserveOptions {
  actor: string;
  rationale?: string;
  at?: string;
}

export interface AskOptions {
  actor: string;
  question: string;
  rationale?: string;
  at?: string;
}

export interface AnswerOptions {
  actor: string;
  answer: string;
  rationale?: string;
  at?: string;
}

export interface ExternalConfirmOptions extends TakeOptions {
  evidence: Ref[];
}

export async function initState(
  trajectory: Trajectory,
  actor = 'system',
  at = new Date().toISOString(),
): Promise<PlanState> {
  const result = await ruleWalkInit(emitFacts(trajectory), epoch(at));
  if (!result.ok) throw walkError(trajectory, result);
  const state = fromSemantic(trajectory.hash, result.state, {
    observations: [],
    pendingElicitation: null,
    elicitations: [],
    log: [],
  });
  state.log.push({
    at,
    actor,
    from: null,
    choice: null,
    label: null,
    to: state.current,
    rationale: 'plan started',
  });
  return state;
}

export function bindState(trajectory: Trajectory, state: PlanState): void {
  if (state.version !== PLAN_STATE_VERSION) {
    throw unsupportedStateVersion(state.version);
  }
  if (state.hash !== trajectory.hash) throw new DriftError(state.hash, trajectory.hash);
}

export async function frontier(
  trajectory: Trajectory,
  state: PlanState,
  options: { at?: string } = {},
): Promise<AvailableChoice[]> {
  bindState(trajectory, state);
  if (state.status === 'completed') return [];
  const node = nodeById(trajectory, state.current);
  if (state.pendingElicitation) {
    return node.choices.map((choice) => ({
      choice,
      blocked: `waiting for an answer to: ${state.pendingElicitation!.question}`,
      blockedCode: 'elicitation-pending',
    }));
  }
  const items = await ruleWalkFrontier(
    emitFacts(trajectory),
    toSemantic(state),
    epoch(options.at ?? new Date().toISOString()),
  );
  const byId = new Map(items.map((item) => [item.choiceId, item]));
  return node.choices.map((choice) => {
    const item = byId.get(choice.id);
    if (!item) {
      throw new WalkError(`rule engine omitted choice "${choice.id}" from the frontier`, 'invalid-state');
    }
    return {
      choice,
      blocked: item.blockedCode === null ? null : frontierBlockedText(item),
      blockedCode: item.blockedCode as AvailableChoice['blockedCode'],
    };
  });
}

export async function takeChoice(
  trajectory: Trajectory,
  state: PlanState,
  ref: string,
  options: TakeOptions,
): Promise<PlanState> {
  bindState(trajectory, state);
  if (state.status === 'completed') {
    throw new WalkError(refusalText({ kind: 'completed' }), 'completed');
  }
  if (state.pendingElicitation) {
    throw new WalkError(
      `an @input request is already pending: ${state.pendingElicitation.question}`,
      'elicitation-pending',
    );
  }
  const selected = resolveChoiceRef(nodeById(trajectory, state.current), ref);
  const interaction = interactionKind(trajectory, selected);
  if (interaction === 'input') {
    throw new WalkError(
      `choice "${selected.label}" is an @input checkpoint: open it with a focused question before advancing`,
      'elicitation-required',
    );
  }
  if (interaction === 'ask' && options.actor === 'agent') {
    throw new WalkError(
      `choice "${selected.label}" asks the trusted operator to decide`,
      'operator-checkpoint',
    );
  }
  if (interaction === 'external-human') {
    throw new WalkError(
      `choice "${selected.label}" requires evidenced human confirmation`,
      'external-confirmation-required',
    );
  }
  return applyChoice(trajectory, state, ref, options);
}

export async function confirmExternal(
  trajectory: Trajectory,
  state: PlanState,
  ref: string,
  options: ExternalConfirmOptions,
): Promise<PlanState> {
  bindState(trajectory, state);
  if (options.actor === 'agent') {
    throw new WalkError('human confirmation cannot be attributed to the agent', 'human-checkpoint');
  }
  const selected = resolveChoiceRef(nodeById(trajectory, state.current), ref);
  if (!isExternalHumanChoice(trajectory, selected)) {
    throw new WalkError(
      `choice "${selected.label}" is not an evidenced @human checkpoint`,
      'external-confirmation-required',
    );
  }
  if (options.evidence.length === 0) {
    throw new WalkError(
      `@human choice "${selected.label}" requires durable evidence`,
      'external-evidence-required',
    );
  }
  return applyChoice(trajectory, state, ref, options);
}

async function applyChoice(
  trajectory: Trajectory,
  state: PlanState,
  ref: string,
  options: TakeOptions,
): Promise<PlanState> {
  const at = options.at ?? new Date().toISOString();
  const result = await ruleWalkApply(
    emitFacts(trajectory),
    toSemantic(state),
    {
      kind: 'choose',
      ref,
      actor: options.actor,
      hasRationale: Boolean(options.rationale),
    },
    epoch(at),
  );
  if (!result.ok) throw walkError(trajectory, result);

  const choiceId = result.effect.choiceId;
  const choice = typeof choiceId === 'string' ? choiceById(trajectory, choiceId) : null;
  const next = fromSemantic(trajectory.hash, result.state, state);
  next.log.push({
    at,
    actor: options.actor,
    from: result.effect.from ?? state.current,
    choice: choice?.id ?? null,
    label: choice?.label ?? null,
    to: result.effect.to ?? next.current,
    rationale: options.rationale ?? null,
  });
  return next;
}

/** Open an `@input` edge (or a legacy spec-0.5 `@ask`) without advancing it. */
export async function ask(
  trajectory: Trajectory,
  state: PlanState,
  ref: string,
  options: AskOptions,
): Promise<PlanState> {
  bindState(trajectory, state);
  if (state.status === 'completed') {
    throw new WalkError(refusalText({ kind: 'completed' }), 'completed');
  }
  if (state.pendingElicitation) {
    throw new WalkError(
      `an @input request is already pending: ${state.pendingElicitation.question}`,
      'elicitation-pending',
    );
  }
  if (!options.question.trim()) {
    throw new WalkError('an @input checkpoint requires a focused question', 'rationale-required');
  }
  const choice = resolveChoiceRef(nodeById(trajectory, state.current), ref);
  if (!isInputChoice(trajectory, choice)) {
    throw new WalkError(`choice "${choice.label}" is not an @input checkpoint`, 'elicitation-required');
  }
  const available = await frontier(trajectory, state, { at: options.at });
  const selected = available.find((item) => item.choice.id === choice.id);
  if (!selected || selected.blocked) {
    throw new WalkError(
      `choice "${choice.label}" is not available: ${selected?.blocked ?? 'not in the frontier'}`,
      selected?.blockedCode ?? 'elicitation-required',
    );
  }
  const at = options.at ?? new Date().toISOString();
  const next = structuredClone(state);
  next.pendingElicitation = {
    choice: choice.id,
    target: choice.target,
    question: options.question.trim(),
    askedAt: at,
    askedBy: options.actor,
    rationale: options.rationale ?? null,
  };
  next.elicitations.push({
    choice: choice.id,
    label: choice.label,
    target: choice.target,
    question: options.question.trim(),
    askedAt: at,
    askedBy: options.actor,
    rationale: options.rationale ?? null,
    answer: null,
    answeredAt: null,
    answeredBy: null,
  });
  return next;
}

/** Record a human answer and advance the fixed `@input` edge. */
export async function answer(
  trajectory: Trajectory,
  state: PlanState,
  options: AnswerOptions,
): Promise<PlanState> {
  bindState(trajectory, state);
  const pending = state.pendingElicitation;
  if (!pending) {
    throw new WalkError('there is no @input request awaiting an answer', 'elicitation-required');
  }
  if (options.actor === 'agent') {
    throw new WalkError('an @input answer must be attributed to a human', 'human-checkpoint');
  }
  if (!options.answer.trim()) {
    throw new WalkError('an @input answer cannot be empty', 'rationale-required');
  }
  const at = options.at ?? new Date().toISOString();
  const rationale = `clarified by ${options.actor}: ${options.answer.trim()}` +
    (options.rationale ? ` (${options.rationale})` : '');
  const next = await applyChoice(trajectory, state, pending.choice, {
    actor: 'agent',
    rationale,
    at,
  });
  next.pendingElicitation = null;
  let exchange = undefined;
  for (let index = next.elicitations.length - 1; index >= 0; index--) {
    const candidate = next.elicitations[index];
    if (candidate.choice === pending.choice && candidate.answer === null) {
      exchange = candidate;
      break;
    }
  }
  if (!exchange) {
    throw new WalkError('pending elicitation has no matching audit entry', 'invalid-state');
  }
  exchange.answer = options.answer.trim();
  exchange.answeredAt = at;
  exchange.answeredBy = options.actor;
  return next;
}

export async function advance(
  trajectory: Trajectory,
  state: PlanState,
  options: TakeOptions,
): Promise<PlanState> {
  bindState(trajectory, state);
  if (state.pendingElicitation) {
    throw new WalkError(
      `an @input request is pending: ${state.pendingElicitation.question}`,
      'elicitation-pending',
    );
  }
  const at = options.at ?? new Date().toISOString();
  const result = await ruleWalkApply(
    emitFacts(trajectory),
    toSemantic(state),
    { kind: 'advance' },
    epoch(at),
  );
  if (!result.ok) throw walkError(trajectory, result);

  const next = fromSemantic(trajectory.hash, result.state, state);
  next.log.push({
    at,
    actor: options.actor,
    from: result.effect.from ?? state.current,
    choice: null,
    label: null,
    to: result.effect.to ?? next.current,
    rationale: options.rationale ?? 'followed automatic next step',
  });
  return next;
}

export async function observe(
  trajectory: Trajectory,
  state: PlanState,
  name: string,
  value: Value,
  options: ObserveOptions,
): Promise<PlanState> {
  bindState(trajectory, state);
  if (state.pendingElicitation) {
    throw new WalkError(
      `an @input request is pending: ${state.pendingElicitation.question}`,
      'elicitation-pending',
    );
  }
  const at = options.at ?? new Date().toISOString();
  const valueType =
    typeof value === 'number' && !Number.isFinite(value)
      ? 'non-finite-number'
      : typeof value;
  const operationValue =
    typeof value === 'number' && !Number.isFinite(value) ? null : value;
  const result = await ruleWalkApply(
    emitFacts(trajectory),
    toSemantic(state),
    {
      kind: 'observe',
      name,
      value: operationValue,
      valueType,
      hasRationale: Boolean(options.rationale),
    },
    epoch(at),
  );
  if (!result.ok) throw walkError(trajectory, result);

  const next = fromSemantic(trajectory.hash, result.state, state);
  next.observations.push({
    at,
    actor: options.actor,
    node: state.pendingEntry ? null : state.current,
    variable: name,
    value,
    rationale: options.rationale ?? null,
  });
  return next;
}

function toSemantic(state: PlanState): RuleSemanticState {
  return {
    status: state.status,
    current: state.current,
    variables: { ...state.variables },
    taken: [...state.taken],
    pendingObservations: [...state.pendingObservations],
    pendingEntry: state.pendingEntry,
    activationStartedAtMs:
      state.activationStartedAt === null ? -1 : epoch(state.activationStartedAt),
  };
}

function fromSemantic(
  hash: string,
  semantic: RuleSemanticState,
  audit: Pick<PlanState, 'observations' | 'pendingElicitation' | 'elicitations' | 'log'>,
): PlanState {
  return {
    version: PLAN_STATE_VERSION,
    hash,
    status: semantic.status,
    current: semantic.current,
    variables: { ...semantic.variables },
    pendingObservations: [...semantic.pendingObservations],
    pendingEntry: semantic.pendingEntry,
    activationStartedAt:
      semantic.activationStartedAtMs < 0
        ? null
        : new Date(semantic.activationStartedAtMs).toISOString(),
    observations: audit.observations.map((entry) => ({ ...entry })),
    pendingElicitation: audit.pendingElicitation
      ? { ...audit.pendingElicitation }
      : null,
    elicitations: audit.elicitations.map((entry) => ({ ...entry })),
    taken: [...semantic.taken],
    log: audit.log.map((entry) => ({ ...entry })),
  };
}

function nodeById(trajectory: Trajectory, id: string): TrajectoryNode {
  const node = trajectory.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new WalkError(refusalText({ kind: 'unknown-node', id }), 'unknown-node');
  return node;
}

function choiceById(trajectory: Trajectory, id: string): Choice {
  for (const node of trajectory.nodes) {
    const choice = node.choices.find((candidate) => candidate.id === id);
    if (choice) return choice;
  }
  throw new WalkError(`choice "${id}" does not exist in the compiled plan`, 'unknown-choice');
}

function resolveChoiceRef(node: TrajectoryNode, ref: string): Choice {
  const byId = node.choices.find((choice) => choice.id === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) {
    const index = Number(ref);
    const choice = node.choices[index];
    if (choice) return choice;
    throw new WalkError(
      refusalText({ kind: 'bad-index', id: node.id, index, max: node.choices.length - 1 }),
      'unknown-choice',
    );
  }
  const matches = node.choices.filter((choice) =>
    choice.label.toLowerCase().startsWith(ref.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new WalkError(
      refusalText({ kind: 'ambiguous', ref, id: node.id }),
      'ambiguous-choice',
    );
  }
  throw new WalkError(
    refusalText({
      kind: 'no-match',
      ref,
      id: node.id,
      available: node.choices.map((choice, index) => `[${index}] ${choice.label}`).join(', '),
    }),
    'unknown-choice',
  );
}

function frontierBlockedText(item: RuleFrontierItem): string {
  const detail = item.detail;
  switch (String(detail['kind'])) {
    case 'observation-required':
      return blockedText({
        kind: 'observation-required',
        names: stringArray(detail['names']),
      });
    case 'once-exhausted':
      return blockedText({ kind: 'once-exhausted' });
    case 'timeout-pending':
      return blockedText({
        kind: 'timeout-pending',
        source: String(detail['source']),
        remaining: spanText(Number(detail['remainingMs'])),
      });
    case 'timed-out':
      return blockedText({ kind: 'timed-out', source: String(detail['source']) });
    case 'gate-false':
      return blockedText({
        kind: 'gate-false',
        source: String(detail['source']),
        value: String(detail['value']),
      });
    case 'gate-error':
      return blockedText({
        kind: 'gate-error',
        source: String(detail['source']),
        error: 'expression is invalid for the current variables',
      });
    default:
      return `unavailable (${String(item.blockedCode)})`;
  }
}

function walkError(
  trajectory: Trajectory,
  result: Extract<RuleWalkResult, { ok: false }>,
): WalkError {
  const detail = result.detail;
  const code = result.code as WalkErrorCode;
  const kind = String(detail['kind']);
  let message: string;
  switch (kind) {
    case 'completed':
      message = refusalText({ kind: 'completed' });
      break;
    case 'observation-required':
      message = `runtime observation required before continuing: ${stringArray(detail['names']).join(', ')}`;
      break;
    case 'once-exhausted':
    case 'timeout-pending':
    case 'timed-out':
    case 'gate-false':
    case 'gate-error': {
      const choice = blockedChoice(trajectory, result.state, detail);
      message = refusalText({
        kind: 'not-available',
        label: choice?.label ?? 'selected choice',
        blocked: frontierBlockedText({
          choiceId: choice?.id ?? '',
          blockedCode: code,
          detail,
        }),
      });
      break;
    }
    case 'human-checkpoint': {
      const choice = choiceById(trajectory, String(detail['choiceId']));
      message = refusalText({ kind: 'human-checkpoint', label: choice.label });
      break;
    }
    case 'rationale-required': {
      const choice = choiceById(trajectory, String(detail['choiceId']));
      message = choice.human
        ? refusalText({ kind: 'rationale-human', label: choice.label })
        : refusalText({ kind: 'rationale-missing' });
      break;
    }
    case 'observation-rationale-required':
      message = 'every runtime observation must record a rationale: pass --rationale (G4)';
      break;
    case 'no-next-step':
      message = refusalText({ kind: 'no-next-step', id: String(detail['nodeId']) });
      break;
    case 'unknown-observation':
      message = `"${String(detail['name'])}" is not awaiting a runtime observation`;
      break;
    case 'observation-type':
      message =
        `observation "${String(detail['name'])}" expects ${String(detail['expected'])}, got ` +
        String(detail['actual']);
      break;
    case 'ambiguous-choice':
      message = refusalText({
        kind: 'ambiguous',
        ref: String(detail['ref']),
        id: String(detail['nodeId']),
      });
      break;
    case 'bad-index': {
      const count = Number(detail['count']);
      const id = String(detail['nodeId']);
      message = count === 0
        ? refusalText({
            kind: 'no-choices',
            id,
            nextTarget: trajectory.nodes.find((node) => node.id === id)?.next?.target ?? null,
          })
        : refusalText({
            kind: 'bad-index',
            id,
            index: Number(detail['index']),
            max: count - 1,
          });
      break;
    }
    case 'unknown-choice': {
      const id = String(detail['nodeId']);
      const node = trajectory.nodes.find((candidate) => candidate.id === id);
      message = refusalText({
        kind: 'no-match',
        ref: String(detail['ref']),
        id,
        available: node?.choices.map((choice, index) => `[${index}] ${choice.label}`).join(', ') ?? '',
      });
      break;
    }
    default:
      message = `walk refused (${result.code}): ${JSON.stringify(detail)}`;
  }
  return new WalkError(message, code);
}

function blockedChoice(
  trajectory: Trajectory,
  state: RuleSemanticState,
  detail: Record<string, unknown>,
): Choice | undefined {
  if (typeof detail['choiceId'] === 'string') {
    return trajectory.nodes
      .flatMap((node) => node.choices)
      .find((choice) => choice.id === detail['choiceId']);
  }
  const node = trajectory.nodes.find((candidate) => candidate.id === state.current);
  if (!node) return undefined;
  if (detail['source'] !== undefined) {
    return node.choices.find((choice) =>
      choice.timeout?.source === detail['source'] || choice.gate?.source === detail['source']);
  }
  return node.choices.find((choice) => state.taken.includes(choice.id) && !choice.sticky);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function epoch(at: string): number {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) {
    throw new WalkError(`invalid timestamp "${at}"`, 'invalid-state');
  }
  return parsed;
}

function spanText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

/** Start of the current activation; direct self-loops do not reset it. */
export function enteredAt(state: PlanState, nodeId: string): string | null {
  return state.status === 'active' && state.current === nodeId
    ? state.activationStartedAt
    : historicalEnteredAt(state, nodeId);
}

function historicalEnteredAt(state: PlanState, nodeId: string): string | null {
  let found: string | null = null;
  for (let index = state.log.length - 1; index >= 0; index--) {
    const entry = state.log[index];
    if (entry.to !== nodeId) {
      if (found) break;
      continue;
    }
    found = entry.at;
    if (entry.from !== nodeId) break;
  }
  return found;
}

export function visitedPath(state: PlanState): string[] {
  return state.log.map((entry) => entry.to);
}

export function parseState(json: string): PlanState {
  const value = JSON.parse(json) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WalkError('invalid state file: expected a JSON object', 'invalid-state');
  }
  const parsed = value as Partial<PlanState>;
  for (const key of [
    'version',
    'hash',
    'status',
    'current',
    'variables',
    'pendingObservations',
    'pendingEntry',
    'activationStartedAt',
    'observations',
    'taken',
    'log',
  ] as const) {
    if (!(key in parsed)) {
      throw new WalkError(refusalText({ kind: 'invalid-state', key }), 'invalid-state');
    }
  }
  if (parsed.version !== PLAN_STATE_VERSION) {
    throw unsupportedStateVersion(parsed.version);
  }
  // State v2 predates @input. Its additive audit fields default cleanly so
  // existing runs do not need to be discarded.
  parsed.pendingElicitation ??= null;
  parsed.elicitations ??= [];
  if (parsed.status === 'active' && typeof parsed.activationStartedAt !== 'string') {
    throw new WalkError(
      'invalid state file: active state requires "activationStartedAt"',
      'invalid-state',
    );
  }
  if (parsed.status === 'completed' && parsed.activationStartedAt !== null) {
    throw new WalkError(
      'invalid state file: completed state requires "activationStartedAt": null',
      'invalid-state',
    );
  }
  return parsed as PlanState;
}

function unsupportedStateVersion(version: unknown): WalkError {
  return new WalkError(
    `unsupported state version ${String(version)}; expected ${PLAN_STATE_VERSION}. ` +
    'Re-initialise the state with "marionette state init --force".',
    'invalid-state',
  );
}

export interface MigrationReport {
  fromHash: string;
  toHash: string;
  amendment: AmendmentReport | null;
  droppedTaken: string[];
  droppedVariables: Record<string, Value>;
  addedVariables: Record<string, Value>;
  addedObservations: string[];
  resetVariables: string[];
  missingVisited: string[];
}

export interface RebindOptions {
  actor?: string;
  rationale?: string | null;
  at?: string;
  /** Required for a semantic amendment; its hash must match the bound state. */
  previousTrajectory?: Trajectory;
}

/**
 * Rebind remains a persistence-layer operation. It mutates the supplied state
 * deliberately; semantic walker transitions above are immutable.
 */
export function rebindState(
  trajectory: Trajectory,
  state: PlanState,
  options: RebindOptions = {},
): MigrationReport {
  const report: MigrationReport = {
    fromHash: state.hash,
    toHash: trajectory.hash,
    amendment: null,
    droppedTaken: [],
    droppedVariables: {},
    addedVariables: {},
    addedObservations: [],
    resetVariables: [],
    missingVisited: [],
  };
  if (state.hash === trajectory.hash) return report;

  if (!options.previousTrajectory) {
    throw new WalkError(
      'cannot verify a future-only amendment without the previous archived trajectory',
      'migration-blocked',
    );
  }
  report.amendment = analyzeAmendment(options.previousTrajectory, trajectory, state);
  if (!report.amendment.allowed) {
    throw new WalkError(
      'plan amendment would rewrite completed work:\n' +
      report.amendment.violations.map((violation) => `  - ${violation.message}`).join('\n'),
      'migration-blocked',
    );
  }

  const nodeIds = new Set(trajectory.nodes.map((node) => node.id));
  if (state.current !== END && !nodeIds.has(state.current)) {
    throw new WalkError(refusalText({ kind: 'migration-blocked', current: state.current }), 'migration-blocked');
  }

  const choiceIds = new Set(trajectory.nodes.flatMap((node) => node.choices.map((choice) => choice.id)));
  if (state.pendingElicitation) {
    const pendingChoice = trajectory.nodes
      .flatMap((node) => node.choices)
      .find((choice) => choice.id === state.pendingElicitation!.choice);
    if (!pendingChoice || !isInputChoice(trajectory, pendingChoice) ||
        pendingChoice.target !== state.pendingElicitation.target) {
      throw new WalkError(
        `cannot rebind while input "${state.pendingElicitation.choice}" is pending and its edge changed`,
        'migration-blocked',
      );
    }
  }
  report.droppedTaken = state.taken.filter((id) => !choiceIds.has(id));
  state.taken = state.taken.filter((id) => choiceIds.has(id));

  for (const [name, value] of Object.entries(state.variables)) {
    const declaration = trajectory.variables[name];
    if (!declaration) {
      report.droppedVariables[name] = value;
      delete state.variables[name];
    } else if (typeof value !== declaration.type) {
      report.resetVariables.push(name);
      if (declaration.initial === null) {
        delete state.variables[name];
        if (!state.pendingObservations.includes(name)) state.pendingObservations.push(name);
      } else {
        state.variables[name] = declaration.initial;
      }
    }
  }
  for (const [name, declaration] of Object.entries(trajectory.variables)) {
    if (name in state.variables) continue;
    if (declaration.initial === null) {
      report.addedObservations.push(name);
      if (!state.pendingObservations.includes(name)) state.pendingObservations.push(name);
    } else {
      report.addedVariables[name] = declaration.initial;
      state.variables[name] = declaration.initial;
    }
  }
  state.pendingObservations = state.pendingObservations.filter((name) => name in trajectory.variables);
  report.missingVisited = [...new Set(
    visitedPath(state).filter((id) => id !== END && !nodeIds.has(id)),
  )];

  state.hash = trajectory.hash;
  state.log.push({
    at: options.at ?? new Date().toISOString(),
    actor: options.actor ?? 'system',
    from: null,
    choice: null,
    label: `plan rebound ${report.fromHash.slice(0, 19)}… → ${report.toHash.slice(0, 19)}…`,
    to: state.current,
    rationale: options.rationale ?? null,
  });
  return report;
}

export function serializeState(state: PlanState): string {
  return JSON.stringify(state, null, 2) + '\n';
}
