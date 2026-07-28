/**
 * Quarantined pre-cutover TypeScript walker.
 *
 * Test-only shadow for the 30-day differential confidence window. Production
 * must not import this file; walker semantics execute in Prolog.
 */

import type { Choice, LogEntry, PlanState, Trajectory, TrajectoryNode, Value } from '../../src/types.ts';
import { END, PLAN_STATE_VERSION } from '../../src/types.ts';
import { ExprError, evalExpr } from '../../src/expr.ts';
import { blockedText, refusalText } from '../../src/diagnostics.ts';

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

/**
 * Machine-readable walk refusal codes — the conformance contract for any
 * runtime implementation (spec/conformance): a conforming walker must refuse
 * for the same reason, whatever its human-facing message says.
 */
export type WalkErrorCode =
  | 'completed'            // the plan has already reached END
  | 'unknown-node'         // state points at a node absent from the compiled plan
  | 'unknown-choice'       // no choice matches the given reference
  | 'ambiguous-choice'     // a label prefix matched more than one choice
  | 'gate-blocked'         // the choice's gate is currently false (or failed to evaluate)
  | 'observation-required' // a late-bound/refreshed value must be supplied
  | 'unknown-observation'  // the supplied variable is not currently requested
  | 'observation-type'     // supplied value does not match its declared type
  | 'timeout-pending'      // a timeout edge was selected before it elapsed
  | 'timed-out'            // a normal edge was selected after a hard timeout
  | 'once-exhausted'       // a once-only (`*`) choice was already taken
  | 'human-checkpoint'     // an agent tried to take an @human choice
  | 'rationale-required'   // the step is missing its auditable rationale (G4)
  | 'no-next-step'         // advance() called on a node without an automatic next step
  | 'migration-blocked'    // state cannot be rebound onto the new plan
  | 'invalid-state';       // the state file is structurally invalid

export class WalkError extends Error {
  constructor(message: string, public readonly code: WalkErrorCode) {
    super(message);
    this.name = 'WalkError';
  }
}

export function initState(trajectory: Trajectory, actor = 'system', at = new Date().toISOString()): PlanState {
  const initial = Object.entries(trajectory.variables)
    .filter(([, decl]) => decl.initial !== null);
  const pending = Object.entries(trajectory.variables)
    .filter(([, decl]) => decl.initial === null)
    .map(([name]) => name);
  const state: PlanState = {
    version: PLAN_STATE_VERSION,
    hash: trajectory.hash,
    status: 'active',
    current: trajectory.start,
    variables: Object.fromEntries(initial.map(([name, decl]) => [name, decl.initial!])),
    pendingObservations: pending,
    pendingEntry: pending.length > 0,
    activationStartedAt: at,
    observations: [],
    taken: [],
    log: [],
  };
  enterNode(trajectory, state, trajectory.start, {
    at, actor, from: null, choice: null, label: null, rationale: 'plan started',
  });
  return state;
}

export function bindState(trajectory: Trajectory, state: PlanState): void {
  if (state.hash !== trajectory.hash) throw new DriftError(state.hash, trajectory.hash);
}

function nodeById(trajectory: Trajectory, id: string): TrajectoryNode {
  const node = trajectory.nodes.find((n) => n.id === id);
  if (!node) throw new WalkError(refusalText({ kind: 'unknown-node', id }), 'unknown-node');
  return node;
}

export interface AvailableChoice {
  choice: Choice;
  /** Why the choice is currently unavailable, or null if it can be taken. */
  blocked: string | null;
  /** Machine-readable reason, paired with `blocked`. */
  blockedCode:
    | 'once-exhausted'
    | 'gate-blocked'
    | 'observation-required'
    | 'timeout-pending'
    | 'timed-out'
    | null;
}

/** Evaluate the frontier at the current node: each choice with availability. */
export function frontier(
  trajectory: Trajectory,
  state: PlanState,
  options: { at?: string } = {},
): AvailableChoice[] {
  if (state.status === 'completed') return [];
  const node = nodeById(trajectory, state.current);
  const at = options.at ?? new Date().toISOString();
  const elapsed = elapsedInNode(state, node.id, at);
  const expiredTimeout = node.choices.find((choice) =>
    choice.timeout && elapsed >= choice.timeout.seconds * 1000);
  return node.choices.map((choice) => {
    if (state.pendingObservations.length > 0) {
      return {
        choice,
        blocked: blockedText({
          kind: 'observation-required',
          names: state.pendingObservations,
        }),
        blockedCode: 'observation-required' as const,
      };
    }
    if (!choice.sticky && state.taken.includes(choice.id)) {
      return { choice, blocked: blockedText({ kind: 'once-exhausted' }), blockedCode: 'once-exhausted' as const };
    }
    if (choice.timeout) {
      const remaining = Math.max(0, choice.timeout.seconds * 1000 - elapsed);
      if (remaining > 0) {
        return {
          choice,
          blocked: blockedText({
            kind: 'timeout-pending',
            source: choice.timeout.source,
            remaining: spanText(remaining),
          }),
          blockedCode: 'timeout-pending' as const,
        };
      }
    } else if (expiredTimeout?.timeout) {
      return {
        choice,
        blocked: blockedText({ kind: 'timed-out', source: expiredTimeout.timeout.source }),
        blockedCode: 'timed-out' as const,
      };
    }
    if (choice.gate) {
      try {
        const value = evalExpr(choice.gate.ast, state.variables);
        if (value !== true) {
          return {
            choice,
            blocked: blockedText({ kind: 'gate-false', source: choice.gate.source, value: JSON.stringify(value) }),
            blockedCode: 'gate-blocked' as const,
          };
        }
      } catch (e) {
        return {
          choice,
          blocked: blockedText({ kind: 'gate-error', source: choice.gate.source, error: (e as ExprError).message }),
          blockedCode: 'gate-blocked' as const,
        };
      }
    }
    return { choice, blocked: null, blockedCode: null };
  });
}

export interface TakeOptions {
  actor: string;
  rationale?: string;
  at?: string;
}

/** Take a choice by id, index, or unambiguous label prefix. */
export function takeChoice(trajectory: Trajectory, state: PlanState, ref: string, opts: TakeOptions): void {
  if (state.status === 'completed') throw new WalkError(refusalText({ kind: 'completed' }), 'completed');
  const node = nodeById(trajectory, state.current);
  const choice = resolveChoice(node, ref);
  const availability = frontier(trajectory, state, { at: opts.at }).find((a) => a.choice.id === choice.id)!;
  if (availability.blocked) {
    throw new WalkError(
      refusalText({ kind: 'not-available', label: choice.label, blocked: availability.blocked }),
      availability.blockedCode ?? 'gate-blocked',
    );
  }
  if (choice.human) {
    if (!opts.actor || opts.actor === 'agent') {
      throw new WalkError(refusalText({ kind: 'human-checkpoint', label: choice.label }), 'human-checkpoint');
    }
    if (!opts.rationale) {
      throw new WalkError(refusalText({ kind: 'rationale-human', label: choice.label }), 'rationale-required');
    }
  }
  if (!opts.rationale) {
    throw new WalkError(refusalText({ kind: 'rationale-missing' }), 'rationale-required');
  }
  if (!choice.sticky) state.taken.push(choice.id);
  enterNode(trajectory, state, choice.target, {
    at: opts.at ?? new Date().toISOString(),
    actor: opts.actor,
    from: node.id,
    choice: choice.id,
    label: choice.label,
    rationale: opts.rationale ?? null,
  });
}

/** Follow the automatic next step of the current node. */
export function advance(trajectory: Trajectory, state: PlanState, opts: TakeOptions): void {
  if (state.status === 'completed') throw new WalkError(refusalText({ kind: 'completed' }), 'completed');
  const node = nodeById(trajectory, state.current);
  if (state.pendingObservations.length > 0) {
    throw new WalkError(
      `runtime observation required before leaving "${node.id}": ${state.pendingObservations.join(', ')}`,
      'observation-required',
    );
  }
  const expired = node.choices.find((choice) =>
    choice.timeout &&
    elapsedInNode(state, node.id, opts.at ?? new Date().toISOString()) >= choice.timeout.seconds * 1000);
  if (expired?.timeout) {
    throw new WalkError(
      `automatic next step is unavailable: phase timeout ${expired.timeout.source} has elapsed`,
      'timed-out',
    );
  }
  if (!node.next) {
    throw new WalkError(refusalText({ kind: 'no-next-step', id: node.id }), 'no-next-step');
  }
  enterNode(trajectory, state, node.next.target, {
    at: opts.at ?? new Date().toISOString(),
    actor: opts.actor,
    from: node.id,
    choice: null,
    label: null,
    rationale: opts.rationale ?? 'followed automatic next step',
  });
}

function resolveChoice(node: TrajectoryNode, ref: string): Choice {
  const byId = node.choices.find((c) => c.id === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) {
    const idx = Number(ref);
    if (idx >= 0 && idx < node.choices.length) return node.choices[idx];
    if (node.choices.length === 0) {
      throw new WalkError(
        refusalText({ kind: 'no-choices', id: node.id, nextTarget: node.next?.target ?? null }),
        'unknown-choice');
    }
    throw new WalkError(
      refusalText({ kind: 'bad-index', id: node.id, index: idx, max: node.choices.length - 1 }),
      'unknown-choice');
  }
  const byLabel = node.choices.filter((c) => c.label.toLowerCase().startsWith(ref.toLowerCase()));
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) {
    throw new WalkError(refusalText({ kind: 'ambiguous', ref, id: node.id }), 'ambiguous-choice');
  }
  throw new WalkError(
    refusalText({
      kind: 'no-match', ref, id: node.id,
      available: node.choices.map((c, i) => `[${i}] ${c.label}`).join(', '),
    }),
    'unknown-choice',
  );
}

function enterNode(
  trajectory: Trajectory,
  state: PlanState,
  target: string,
  entry: Omit<LogEntry, 'to'>,
): void {
  state.log.push({ ...entry, to: target });
  if (target === END) {
    state.current = END;
    state.status = 'completed';
    state.activationStartedAt = null;
    return;
  }
  const node = nodeById(trajectory, target);
  if (target !== state.current) state.activationStartedAt = entry.at;
  state.current = node.id;
  if (state.pendingEntry) return;
  applyEntry(trajectory, state, node);
}

function applyEntry(trajectory: Trajectory, state: PlanState, node: TrajectoryNode): void {
  for (const action of node.actions) {
    const value = evalExpr(action.value, state.variables);
    const current = state.variables[action.var];
    switch (action.op) {
      case '=':
        state.variables[action.var] = value;
        break;
      case '+=':
        state.variables[action.var] = (current as number) + (value as number);
        break;
      case '-=':
        state.variables[action.var] = (current as number) - (value as number);
        break;
    }
  }
  armObservations(trajectory, state, node);
}

function armObservations(trajectory: Trajectory, state: PlanState, node: TrajectoryNode): void {
  for (const observation of node.observations ?? []) {
    if (!(observation.var in trajectory.variables)) continue;
    delete state.variables[observation.var];
    if (!state.pendingObservations.includes(observation.var)) {
      state.pendingObservations.push(observation.var);
    }
  }
}

export interface ObserveOptions {
  actor: string;
  rationale?: string;
  at?: string;
}

/** Supply one explicitly requested runtime value. */
export function observe(
  trajectory: Trajectory,
  state: PlanState,
  name: string,
  value: Value,
  options: ObserveOptions,
): void {
  if (state.status === 'completed') {
    throw new WalkError(refusalText({ kind: 'completed' }), 'completed');
  }
  if (!state.pendingObservations.includes(name)) {
    throw new WalkError(`"${name}" is not awaiting a runtime observation`, 'unknown-observation');
  }
  if (!options.rationale) {
    throw new WalkError(
      'every runtime observation must record a rationale: pass --rationale (G4)',
      'rationale-required',
    );
  }
  const decl = trajectory.variables[name];
  if (!decl || typeof value !== decl.type ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    throw new WalkError(
      `observation "${name}" expects ${decl?.type ?? 'a declared type'}, got ` +
        `${typeof value === 'number' && !Number.isFinite(value) ? 'a non-finite number' : typeof value}`,
      'observation-type',
    );
  }
  const at = options.at ?? new Date().toISOString();
  state.variables[name] = value;
  state.pendingObservations = state.pendingObservations.filter((item) => item !== name);
  state.observations.push({
    at,
    actor: options.actor,
    node: state.pendingEntry ? null : state.current,
    variable: name,
    value,
    rationale: options.rationale,
  });
  if (state.pendingEntry && state.pendingObservations.length === 0) {
    state.pendingEntry = false;
    applyEntry(trajectory, state, nodeById(trajectory, state.current));
  }
}

/** Start of the current activation; direct self-loops do not reset a timeout. */
export function enteredAt(state: PlanState, nodeId: string): string | null {
  let found: string | null = null;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i];
    if (entry.to !== nodeId) {
      if (found) break;
      continue;
    }
    found = entry.at;
    if (entry.from !== nodeId) break;
  }
  return found;
}

function elapsedInNode(state: PlanState, nodeId: string, at: string): number {
  const entered = enteredAt(state, nodeId);
  if (!entered) return 0;
  return Math.max(0, Date.parse(at) - Date.parse(entered));
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

/** Node ids visited so far, in order (for taken-path rendering). */
export function visitedPath(state: PlanState): string[] {
  return state.log.map((entry) => entry.to);
}

export function parseState(json: string): PlanState {
  const state = JSON.parse(json) as PlanState;
  for (const key of ['hash', 'status', 'current', 'variables', 'taken', 'log'] as const) {
    if (!(key in state)) throw new WalkError(refusalText({ kind: 'invalid-state', key }), 'invalid-state');
  }
  state.pendingObservations ??= [];
  state.pendingEntry ??= false;
  state.observations ??= [];
  return state;
}

/** What `rebind` changed to migrate a state file onto a re-compiled plan. */
export interface MigrationReport {
  fromHash: string;
  toHash: string;
  /** Once-only choice ids no longer present in the new graph (dropped from `taken`). */
  droppedTaken: string[];
  /** Variables no longer declared (dropped, last value noted). */
  droppedVariables: Record<string, Value>;
  /** Newly declared variables (added at their initial values). */
  addedVariables: Record<string, Value>;
  /** Newly declared late-bound variables awaiting an observation. */
  addedObservations: string[];
  /** Variables whose recorded value no longer matches the declared type (reset to initial). */
  resetVariables: string[];
  /** Visited node ids that no longer exist (history kept; informational). */
  missingVisited: string[];
}

/**
 * Migrate a state file onto a re-compiled plan (live-plan migration): the
 * sanctioned alternative to `state init --force` that keeps the decision log.
 * Refuses when the current node no longer exists — that needs a human call.
 */
export interface RebindOptions {
  /** Who authorised the plan amendment this rebind applies (G4 attribution). */
  actor?: string;
  /** Why the plan changed — recorded in the decision log alongside the hashes. */
  rationale?: string | null;
  at?: string;
}

export function rebindState(
  trajectory: Trajectory,
  state: PlanState,
  options: RebindOptions = {},
): MigrationReport {
  const report: MigrationReport = {
    fromHash: state.hash,
    toHash: trajectory.hash,
    droppedTaken: [],
    droppedVariables: {},
    addedVariables: {},
    addedObservations: [],
    resetVariables: [],
    missingVisited: [],
  };
  if (state.hash === trajectory.hash) return report;

  const nodeIds = new Set(trajectory.nodes.map((n) => n.id));
  if (state.current !== END && !nodeIds.has(state.current)) {
    throw new WalkError(refusalText({ kind: 'migration-blocked', current: state.current }), 'migration-blocked');
  }

  const choiceIds = new Set(trajectory.nodes.flatMap((n) => n.choices.map((c) => c.id)));
  report.droppedTaken = state.taken.filter((id) => !choiceIds.has(id));
  state.taken = state.taken.filter((id) => choiceIds.has(id));

  for (const [name, value] of Object.entries(state.variables)) {
    const decl = trajectory.variables[name];
    if (!decl) {
      report.droppedVariables[name] = value;
      delete state.variables[name];
    } else if (typeof value !== decl.type) {
      report.resetVariables.push(name);
      if (decl.initial === null) {
        delete state.variables[name];
        if (!state.pendingObservations.includes(name)) state.pendingObservations.push(name);
      } else {
        state.variables[name] = decl.initial;
      }
    }
  }
  for (const [name, decl] of Object.entries(trajectory.variables)) {
    if (!(name in state.variables)) {
      if (decl.initial === null) {
        report.addedObservations.push(name);
        if (!state.pendingObservations.includes(name)) state.pendingObservations.push(name);
      } else {
        report.addedVariables[name] = decl.initial;
        state.variables[name] = decl.initial;
      }
    }
  }
  state.pendingObservations = state.pendingObservations.filter((name) => name in trajectory.variables);

  report.missingVisited = [...new Set(
    visitedPath(state).filter((id) => id !== END && !nodeIds.has(id)),
  )];

  state.hash = trajectory.hash;

  // A plan amendment is a decision like any branch (G4): log who applied it,
  // against which graph, and why — not just an ephemeral migration report.
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
