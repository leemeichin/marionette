/**
 * Validation composition.
 *
 * TypeScript owns parser/reference/type-shape checks. The bundled Prolog rule
 * engine exclusively owns graph findings (ADR-0003 / issue #21).
 */

import type { Action, Diagnostic, Finding, VariableDecl } from './types.js';
import { CODES, END } from './types.js';
import { tryConstEval, typeOf, varsIn } from './expr.js';
import { renderFinding } from './diagnostics.js';
import { emitFacts } from './facts.js';
import { ruleGraphFindings, type RuleGraphFinding } from './rule-engine.js';
import type { ParsedPlan } from './parser.js';

/** Compose semantic findings into user-facing diagnostics. */
export async function validatePlan(
  plan: ParsedPlan,
  diagnostics: Diagnostic[],
): Promise<void> {
  const priorErrors = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  for (const finding of await analyzePlan(plan, { priorErrors })) {
    diagnostics.push(renderFinding(finding));
  }
}

/**
 * Return all non-parser findings. Graph-layer findings come only from Prolog;
 * upstream errors stop graph analysis because its predicates assume a closed
 * graph.
 */
export async function analyzePlan(
  plan: ParsedPlan,
  options: { priorErrors?: boolean } = {},
): Promise<Finding[]> {
  const findings = analyzeShape(plan);
  if (options.priorErrors || findings.some((finding) => finding.severity === 'error')) {
    return findings;
  }

  const graph = await ruleGraphFindings(emitFacts(plan));
  findings.push(...graph.map((finding) => enrichGraphFinding(plan, finding)));
  return findings;
}

function analyzeShape(plan: ParsedPlan): Finding[] {
  const { nodes, variables } = plan;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const findings: Finding[] = [];
  const error = (
    line: number | undefined,
    code: string,
    data: Finding['data'],
    variant?: string,
  ) => findings.push({ severity: 'error', code, line, data, variant });
  const warn = (
    line: number | undefined,
    code: string,
    data: Finding['data'],
    variant?: string,
  ) => findings.push({ severity: 'warning', code, line, data, variant });

  if (nodes.length === 0) {
    error(undefined, CODES.PARSE, {}, 'no-phases');
    return findings;
  }

  const targetCandidates = [...nodeIds, END];
  const checkTarget = (target: string, line: number, subject: string) => {
    if (target === END || nodeIds.has(target)) return;
    error(line, CODES.UNDEFINED_TARGET, { subject, target, candidates: targetCandidates });
  };
  if (plan.start && !nodeIds.has(plan.start)) {
    error(undefined, CODES.UNDEFINED_TARGET, {
      target: plan.start,
      candidates: [...nodeIds],
    }, 'start');
  }
  for (const node of nodes) {
    for (const choice of node.choices) {
      checkTarget(choice.target, choice.line, `choice "${choice.label}"`);
    }
    if (node.next) checkTarget(node.next.target, node.next.line, 'automatic next step');
  }

  const variableCandidates = Object.keys(variables);
  const usedVariables = new Set<string>();
  const checkVariables = (names: Set<string>, line: number, context: string) => {
    for (const name of names) {
      usedVariables.add(name);
      if (!(name in variables)) {
        error(line, CODES.UNDEFINED_VARIABLE, {
          name,
          context,
          candidates: variableCandidates,
        });
      }
    }
  };

  for (const node of nodes) {
    for (const observation of node.observations) {
      usedVariables.add(observation.var);
      if (!(observation.var in variables)) {
        error(observation.line, CODES.UNDEFINED_VARIABLE, {
          name: observation.var,
          context: `observation checkpoint "? ${observation.var}"`,
          candidates: variableCandidates,
        });
      }
    }
    for (const action of node.actions) {
      usedVariables.add(action.var);
      if (!(action.var in variables)) {
        error(action.line, CODES.UNDEFINED_VARIABLE, {
          name: action.var,
          candidates: variableCandidates,
        }, 'mutation');
      } else {
        checkMutationTypes(action, variables[action.var], error);
      }
      checkVariables(varsIn(action.value), action.line, `mutation of "${action.var}"`);
    }
    for (const choice of node.choices) {
      if (choice.gate) {
        checkVariables(
          varsIn(choice.gate.ast),
          choice.line,
          `gate {${choice.gate.source}}`,
        );
      }
    }
  }

  for (const [name, declaration] of Object.entries(variables)) {
    if (!usedVariables.has(name)) {
      warn(declaration.line, CODES.UNUSED_VARIABLE, { name });
    }
  }

  return findings;
}

function enrichGraphFinding(plan: ParsedPlan, raw: RuleGraphFinding): Finding {
  const data = { ...raw.data } as Finding['data'];
  const choiceId = typeof raw.data['choiceId'] === 'string'
    ? raw.data['choiceId']
    : null;
  const choice = choiceId === null
    ? undefined
    : plan.nodes.flatMap((node) => node.choices).find((candidate) => candidate.id === choiceId);

  if (raw.code === CODES.UNDECLARED_CYCLE && Array.isArray(raw.data['path'])) {
    data['path'] = (raw.data['path'] as unknown[]).map(String).join(' -> ');
  }
  if (raw.code === CODES.CONSTANT_FALSE_GATE) {
    data['label'] = choice?.label ?? choiceId ?? '';
    const reasonKey = String(raw.data['reasonKey'] ?? 'unsatisfiable');
    data['reason'] =
      reasonKey === 'constant_false'
        ? 'gate is constant false'
        : reasonKey === 'initials_false'
          ? 'variables never change from their initial values; gate is false'
          : 'gate is unsatisfiable';
  }
  if (raw.code === CODES.LOOP_NOT_A_CYCLE || raw.code === CODES.LOOP_ONCE_ONLY) {
    data['label'] = choice?.label ?? choiceId ?? '';
  }
  if (raw.code === CODES.UNVERIFIED_GATE) {
    data['source'] = choice?.gate?.source ?? null;
    if (raw.variant !== 'loop-exit') data['label'] = choice?.label ?? choiceId ?? '';
  }

  delete (data as Record<string, unknown>)['choiceId'];
  delete (data as Record<string, unknown>)['reasonKey'];

  return {
    code: raw.code,
    severity: raw.severity,
    line: raw.line,
    variant: raw.variant ?? undefined,
    data,
  };
}

function checkMutationTypes(
  action: Action,
  declaration: VariableDecl,
  error: (
    line: number | undefined,
    code: string,
    data: Finding['data'],
    variant?: string,
  ) => void,
): void {
  if (action.op === '+=' || action.op === '-=') {
    if (declaration.type !== 'number') {
      error(action.line, CODES.TYPE_MISMATCH, {
        op: action.op,
        var: action.var,
        type: declaration.type,
      }, 'op-non-number');
      return;
    }
    const value = tryConstEval(action.value);
    if (value !== undefined && typeof value !== 'number') {
      error(action.line, CODES.TYPE_MISMATCH, {
        op: action.op,
        valueType: typeOf(value),
      }, 'op-value-non-number');
    }
    return;
  }

  const value = tryConstEval(action.value);
  if (value !== undefined && typeOf(value) !== declaration.type) {
    error(action.line, CODES.TYPE_MISMATCH, {
      valueType: typeOf(value),
      var: action.var,
      declType: declaration.type,
    }, 'assign-mismatch');
  }
}
