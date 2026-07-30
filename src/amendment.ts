import type {
  Expr, PlanState, Ref, Trajectory, TrajectoryNode, VariableDecl,
} from './types.ts';
import { END } from './types.ts';
import { isInputChoice } from './gates.ts';

export type AmendmentChangeKind =
  | 'phase-added'
  | 'phase-updated'
  | 'phase-removed'
  | 'variable-added'
  | 'variable-updated'
  | 'variable-removed'
  | 'start-updated'
  | 'plan-metadata-updated';

export interface AmendmentChange {
  kind: AmendmentChangeKind;
  subject: string;
  fields: string[];
}

export type AmendmentViolationCode =
  | 'baseline-hash-mismatch'
  | 'completed-run'
  | 'current-phase-removed'
  | 'completed-phase-changed'
  | 'completed-phase-removed'
  | 'frozen-variable-changed'
  | 'frozen-variable-removed'
  | 'pending-elicitation-changed';

export interface AmendmentViolation {
  code: AmendmentViolationCode;
  subject: string;
  message: string;
  fields: string[];
}

export interface AmendmentReport {
  fromHash: string;
  toHash: string;
  allowed: boolean;
  frozenPhases: string[];
  frozenVariables: string[];
  changes: AmendmentChange[];
  violations: AmendmentViolation[];
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const semanticRefs = (refs: Ref[]) => refs.map(({ provider, kind, id, url }) => ({
  provider, kind, id, url,
}));

const semanticNode = (node: TrajectoryNode) => ({
  body: node.body,
  actions: node.actions.map(({ var: name, op, value, source }) => ({
    var: name, op, value, source,
  })),
  observations: node.observations.map(({ var: name }) => ({ var: name })),
  choices: node.choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    sticky: choice.sticky,
    gate: choice.gate && { source: choice.gate.source, ast: choice.gate.ast },
    human: choice.human,
    ask: choice.ask,
    input: choice.input ?? false,
    loop: choice.loop,
    timeout: choice.timeout && {
      source: choice.timeout.source,
      seconds: choice.timeout.seconds,
    },
    target: choice.target,
  })),
  next: node.next && { target: node.next.target },
  meta: node.meta,
  refs: semanticRefs(node.refs),
});

const nodeFields = (left: TrajectoryNode, right: TrajectoryNode): string[] => {
  const a = semanticNode(left);
  const b = semanticNode(right);
  return (Object.keys(a) as Array<keyof typeof a>)
    .filter((key) => !same(a[key], b[key]));
};

const semanticVariable = ({ type, initial }: VariableDecl) => ({ type, initial });

const expressionVariables = (expression: Expr, output: Set<string>): void => {
  if (expression.kind === 'var') {
    output.add(expression.name);
  } else if (expression.kind === 'unary') {
    expressionVariables(expression.operand, output);
  } else if (expression.kind === 'binary') {
    expressionVariables(expression.left, output);
    expressionVariables(expression.right, output);
  }
};

export function completedPhaseIds(state: PlanState): string[] {
  return [...new Set(state.log.flatMap((entry) => entry.from ? [entry.from] : []))];
}

export function variablesUsedByPhases(
  trajectory: Trajectory,
  phaseIds: Iterable<string>,
): string[] {
  const phases = new Set(phaseIds);
  const variables = new Set<string>();
  for (const node of trajectory.nodes) {
    if (!phases.has(node.id)) continue;
    for (const action of node.actions) {
      variables.add(action.var);
      expressionVariables(action.value, variables);
    }
    for (const observation of node.observations) variables.add(observation.var);
    for (const choice of node.choices) {
      if (choice.gate) expressionVariables(choice.gate.ast, variables);
    }
  }
  return [...variables].sort();
}

/**
 * Compare two compiled trajectories without mutating traversal state. Source
 * locations are deliberately ignored; all executable node semantics are not.
 */
export function analyzeAmendment(
  previous: Trajectory,
  candidate: Trajectory,
  state: PlanState,
): AmendmentReport {
  const frozenPhases = completedPhaseIds(state).sort();
  const frozen = new Set(frozenPhases);
  const frozenVariables = variablesUsedByPhases(previous, frozenPhases);
  const oldNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(candidate.nodes.map((node) => [node.id, node]));
  const changes: AmendmentChange[] = [];
  const violations: AmendmentViolation[] = [];

  if (state.hash !== previous.hash) {
    violations.push({
      code: 'baseline-hash-mismatch',
      subject: previous.hash,
      fields: ['hash'],
      message: `state is bound to ${state.hash}, not baseline ${previous.hash}`,
    });
  }
  if (state.status === 'completed' && previous.hash !== candidate.hash) {
    violations.push({
      code: 'completed-run',
      subject: END,
      fields: [],
      message: 'a completed run has no executable future to amend',
    });
  }
  if (state.current !== END && !newNodes.has(state.current)) {
    violations.push({
      code: 'current-phase-removed',
      subject: state.current,
      fields: [],
      message: `current phase "${state.current}" must survive the amendment`,
    });
  }

  for (const [id, oldNode] of oldNodes) {
    const newNode = newNodes.get(id);
    if (!newNode) {
      changes.push({ kind: 'phase-removed', subject: id, fields: [] });
      if (frozen.has(id)) {
        violations.push({
          code: 'completed-phase-removed',
          subject: id,
          fields: [],
          message: `completed phase "${id}" is immutable and cannot be removed`,
        });
      }
      continue;
    }
    const fields = nodeFields(oldNode, newNode);
    if (fields.length === 0) continue;
    changes.push({ kind: 'phase-updated', subject: id, fields });
    if (frozen.has(id)) {
      violations.push({
        code: 'completed-phase-changed',
        subject: id,
        fields,
        message: `completed phase "${id}" is immutable; changed ${fields.join(', ')}`,
      });
    }
  }
  for (const id of newNodes.keys()) {
    if (!oldNodes.has(id)) changes.push({ kind: 'phase-added', subject: id, fields: [] });
  }

  for (const [name, declaration] of Object.entries(previous.variables)) {
    const next = candidate.variables[name];
    if (!next) {
      changes.push({ kind: 'variable-removed', subject: name, fields: [] });
      if (frozenVariables.includes(name)) {
        violations.push({
          code: 'frozen-variable-removed',
          subject: name,
          fields: [],
          message: `variable "${name}" is used by completed work and cannot be removed`,
        });
      }
      continue;
    }
    const fields = (['type', 'initial'] as const)
      .filter((field) => !same(semanticVariable(declaration)[field], semanticVariable(next)[field]));
    if (fields.length === 0) continue;
    changes.push({ kind: 'variable-updated', subject: name, fields: [...fields] });
    if (frozenVariables.includes(name)) {
      violations.push({
        code: 'frozen-variable-changed',
        subject: name,
        fields: [...fields],
        message: `variable "${name}" is used by completed work and cannot change`,
      });
    }
  }
  for (const name of Object.keys(candidate.variables)) {
    if (!(name in previous.variables)) {
      changes.push({ kind: 'variable-added', subject: name, fields: [] });
    }
  }

  if (previous.start !== candidate.start) {
    changes.push({ kind: 'start-updated', subject: candidate.start, fields: ['start'] });
  }
  if (!same(previous.meta, candidate.meta) || !same(semanticRefs(previous.refs), semanticRefs(candidate.refs))) {
    changes.push({ kind: 'plan-metadata-updated', subject: 'plan', fields: ['meta', 'refs'] });
  }

  if (state.pendingElicitation) {
    const pending = candidate.nodes
      .flatMap((node) => node.choices)
      .find((choice) => choice.id === state.pendingElicitation!.choice);
    if (!pending || !isInputChoice(candidate, pending) ||
        pending.target !== state.pendingElicitation.target) {
      violations.push({
        code: 'pending-elicitation-changed',
        subject: state.pendingElicitation.choice,
        fields: ['input', 'target'],
        message: `pending input "${state.pendingElicitation.choice}" must keep its marker and target`,
      });
    }
  }

  return {
    fromHash: previous.hash,
    toHash: candidate.hash,
    allowed: violations.length === 0,
    frozenPhases,
    frozenVariables,
    changes,
    violations,
  };
}
