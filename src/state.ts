/**
 * Traversal state (P0.7): plan.state.json bound to the compiled trajectory by
 * content hash, with drift detection and a minimal reference walker (a preview
 * of the Phase 2 runtime, enough to dogfood Phase 1).
 */

import type { Choice, LogEntry, PlanState, Trajectory, TrajectoryNode, Value } from './types.js';
import { END } from './types.js';
import { ExprError, evalExpr } from './expr.js';

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

export class WalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalkError';
  }
}

export function initState(trajectory: Trajectory, actor = 'system', at = new Date().toISOString()): PlanState {
  const state: PlanState = {
    hash: trajectory.hash,
    status: 'active',
    current: trajectory.start,
    variables: Object.fromEntries(
      Object.entries(trajectory.variables).map(([name, decl]) => [name, decl.initial]),
    ),
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
  if (!node) throw new WalkError(`node "${id}" does not exist in the compiled plan`);
  return node;
}

export interface AvailableChoice {
  choice: Choice;
  /** Why the choice is currently unavailable, or null if it can be taken. */
  blocked: string | null;
}

/** Evaluate the frontier at the current node: each choice with availability. */
export function frontier(trajectory: Trajectory, state: PlanState): AvailableChoice[] {
  if (state.status === 'completed') return [];
  const node = nodeById(trajectory, state.current);
  return node.choices.map((choice) => {
    if (!choice.sticky && state.taken.includes(choice.id)) {
      return { choice, blocked: 'already taken (once-only choice)' };
    }
    if (choice.gate) {
      try {
        const value = evalExpr(choice.gate.ast, state.variables);
        if (value !== true) return { choice, blocked: `gate {${choice.gate.source}} is ${JSON.stringify(value)}` };
      } catch (e) {
        return { choice, blocked: `gate {${choice.gate.source}} failed to evaluate: ${(e as ExprError).message}` };
      }
    }
    return { choice, blocked: null };
  });
}

export interface TakeOptions {
  actor: string;
  rationale?: string;
  at?: string;
}

/** Take a choice by id, index, or unambiguous label prefix. */
export function takeChoice(trajectory: Trajectory, state: PlanState, ref: string, opts: TakeOptions): void {
  if (state.status === 'completed') throw new WalkError('plan is already completed');
  const node = nodeById(trajectory, state.current);
  const choice = resolveChoice(node, ref);
  const availability = frontier(trajectory, state).find((a) => a.choice.id === choice.id)!;
  if (availability.blocked) {
    throw new WalkError(`choice "${choice.label}" is not available: ${availability.blocked}`);
  }
  if (choice.human) {
    if (!opts.actor || opts.actor === 'agent') {
      throw new WalkError(
        `choice "${choice.label}" is an @human checkpoint: an agent may not take it autonomously. ` +
        'Escalate to a human; a human records the decision with --actor <name>.',
      );
    }
    if (!opts.rationale) {
      throw new WalkError(`@human checkpoint "${choice.label}" requires --rationale (the decision must be auditable)`);
    }
  }
  if (!opts.rationale) {
    throw new WalkError('every taken branch must record a rationale: pass --rationale (G4)');
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

/** Follow the fallthrough divert of the current node (when no choice applies). */
export function advance(trajectory: Trajectory, state: PlanState, opts: TakeOptions): void {
  if (state.status === 'completed') throw new WalkError('plan is already completed');
  const node = nodeById(trajectory, state.current);
  if (!node.divert) throw new WalkError(`phase "${node.id}" has no divert; take one of its choices instead`);
  enterNode(trajectory, state, node.divert.target, {
    at: opts.at ?? new Date().toISOString(),
    actor: opts.actor,
    from: node.id,
    choice: null,
    label: null,
    rationale: opts.rationale ?? 'followed divert',
  });
}

function resolveChoice(node: TrajectoryNode, ref: string): Choice {
  const byId = node.choices.find((c) => c.id === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) {
    const idx = Number(ref);
    if (idx >= 0 && idx < node.choices.length) return node.choices[idx];
    if (node.choices.length === 0) {
      const divert = node.divert
        ? `; it diverts to "${node.divert.target}" — use "marionette state advance"`
        : '';
      throw new WalkError(`phase "${node.id}" has no choices${divert}`);
    }
    throw new WalkError(
      `phase "${node.id}" has no choice at index ${idx} (valid: 0..${node.choices.length - 1})`);
  }
  const byLabel = node.choices.filter((c) => c.label.toLowerCase().startsWith(ref.toLowerCase()));
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new WalkError(`choice reference "${ref}" is ambiguous at "${node.id}"`);
  throw new WalkError(
    `no choice "${ref}" at phase "${node.id}"; available: ` +
    node.choices.map((c, i) => `[${i}] ${c.label}`).join(', '),
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
    return;
  }
  const node = nodeById(trajectory, target);
  state.current = node.id;
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
}

/** Node ids visited so far, in order (for taken-path rendering). */
export function visitedPath(state: PlanState): string[] {
  return state.log.map((entry) => entry.to);
}

export function parseState(json: string): PlanState {
  const state = JSON.parse(json) as PlanState;
  for (const key of ['hash', 'status', 'current', 'variables', 'taken', 'log'] as const) {
    if (!(key in state)) throw new WalkError(`invalid state file: missing "${key}"`);
  }
  return state;
}

export function serializeState(state: PlanState): string {
  return JSON.stringify(state, null, 2) + '\n';
}
