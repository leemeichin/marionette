/**
 * Quarantined pre-cutover TypeScript gate analysis (test-only).
 *
 * We only ever claim a verdict when it is provable:
 *   - constant expressions (no variables) evaluate directly;
 *   - expressions whose variables are never mutated anywhere evaluate against initials;
 *   - single-variable comparisons against a constant, where the variable is a
 *     monotonic counter (only `+=`/`-=` by constant, same direction), are
 *     "eventually true" when the comparison lies in the direction of travel.
 *
 * Everything else is 'unknown' → surfaced as an "unverified gate" warning.
 */

import type { Action, BinOp, Expr, Gate, Value, VariableDecl } from '../../src/types.js';
import { evalExpr, tryConstEval, varsIn } from '../../src/expr.js';

export type GateStatus = 'satisfiable' | 'unsatisfiable' | 'unknown';

export interface GateVerdict {
  status: GateStatus;
  reason: string;
}

export interface GateContext {
  variables: Record<string, VariableDecl>;
  /** Every mutation in the graph, keyed by variable name. */
  mutations: Map<string, Action[]>;
  /**
   * When analysing a loop exit, restrict monotonicity analysis to the mutations
   * that occur inside the loop body (the cycle's SCC).
   */
  scopeMutations?: Map<string, Action[]>;
}

export type Direction = 'inc' | 'dec' | 'none' | 'unknown';

/** Determine the monotonic direction of a variable given a set of mutations. */
export function monotonicDirection(name: string, mutations: Map<string, Action[]>): Direction {
  const actions = mutations.get(name) ?? [];
  if (actions.length === 0) return 'none';
  let sign: 1 | -1 | 0 = 0;
  for (const action of actions) {
    if (action.op === '=') return 'unknown';
    const step = tryConstEval(action.value);
    if (typeof step !== 'number' || step === 0) return 'unknown';
    const delta = action.op === '+=' ? step : -step;
    const s = delta > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return 'unknown';
  }
  return sign > 0 ? 'inc' : 'dec';
}

interface Comparison {
  variable: string;
  op: BinOp;
  constant: number;
}

/** Match `v OP const` or `const OP v` for a numeric comparison. */
function asCounterComparison(expr: Expr): Comparison | null {
  if (expr.kind !== 'binary') return null;
  const { op, left, right } = expr;
  if (!['<', '<=', '>', '>=', '==', '!='].includes(op)) return null;

  const flip: Record<string, BinOp> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

  if (left.kind === 'var') {
    const c = tryConstEval(right);
    if (typeof c === 'number') return { variable: left.name, op, constant: c };
  }
  if (right.kind === 'var') {
    const c = tryConstEval(left);
    if (typeof c === 'number') return { variable: right.name, op: flip[op], constant: c };
  }
  return null;
}

export function analyzeGate(gate: Gate, ctx: GateContext): GateVerdict {
  const vars = varsIn(gate.ast);

  // 1. Constant expression.
  if (vars.size === 0) {
    const value = tryConstEval(gate.ast);
    if (typeof value === 'boolean') {
      return value
        ? { status: 'satisfiable', reason: 'gate is constant true' }
        : { status: 'unsatisfiable', reason: 'gate is constant false' };
    }
    return { status: 'unknown', reason: 'gate does not evaluate to a boolean' };
  }

  // 2. All referenced variables exist and are never mutated → evaluate against initials.
  const allDeclared = [...vars].every((v) => v in ctx.variables);
  const allHaveInitials = [...vars].every((v) => ctx.variables[v]?.initial !== null);
  if (allDeclared && allHaveInitials &&
      [...vars].every((v) => (ctx.mutations.get(v) ?? []).length === 0)) {
    const env: Record<string, Value> = {};
    for (const v of vars) env[v] = ctx.variables[v].initial!;
    try {
      const value = evalExpr(gate.ast, env);
      if (typeof value === 'boolean') {
        return value
          ? { status: 'satisfiable', reason: 'variables never change from their initial values; gate is true' }
          : { status: 'unsatisfiable', reason: 'variables never change from their initial values; gate is false' };
      }
    } catch {
      // fall through to unknown
    }
    return { status: 'unknown', reason: 'gate does not evaluate to a boolean' };
  }

  // 3. Monotonic counter comparison → "eventually true" is provable.
  const cmp = asCounterComparison(gate.ast);
  if (cmp && allDeclared && ctx.variables[cmp.variable]?.type === 'number') {
    const scope = ctx.scopeMutations ?? ctx.mutations;
    const direction = monotonicDirection(cmp.variable, scope);
    // Ensure mutations outside the scope don't undermine monotonicity claims.
    const globalDirection = monotonicDirection(cmp.variable, ctx.mutations);
    if ((direction === 'inc' || direction === 'dec') && globalDirection === direction) {
      if (direction === 'inc' && ['>', '>=', '!='].includes(cmp.op)) {
        return {
          status: 'satisfiable',
          reason: `"${cmp.variable}" increases monotonically, so {${gate.source}} eventually holds`,
        };
      }
      if (direction === 'dec' && ['<', '<=', '!='].includes(cmp.op)) {
        return {
          status: 'satisfiable',
          reason: `"${cmp.variable}" decreases monotonically, so {${gate.source}} eventually holds`,
        };
      }
    }
  }

  // The implicit `else` arm of while/until is a negated gate. If its
  // operand is a monotonic continue condition that must eventually close,
  // the negation must eventually open.
  if (gate.ast.kind === 'unary' && gate.ast.op === '!') {
    const operand = { source: gate.source, ast: gate.ast.operand };
    if (eventuallyFalse(operand, ctx)) {
      return {
        status: 'satisfiable',
        reason: `the complementary gate must open when {${gate.source}} becomes false`,
      };
    }
  }

  return { status: 'unknown', reason: 'not trivially decidable' };
}

/**
 * Provably "eventually false": the dual claim, used for loop-continue gates.
 * A gate like {i < 3} on a ~loop~ edge with a monotonically increasing counter
 * guarantees the loop is bounded — the gate must eventually shut.
 */
export function eventuallyFalse(gate: Gate, ctx: GateContext): boolean {
  const cmp = asCounterComparison(gate.ast);
  if (!cmp) return false;
  if (ctx.variables[cmp.variable]?.type !== 'number') return false;
  const scope = ctx.scopeMutations ?? ctx.mutations;
  const direction = monotonicDirection(cmp.variable, scope);
  const globalDirection = monotonicDirection(cmp.variable, ctx.mutations);
  if (direction !== globalDirection) return false;
  if (direction === 'inc') return ['<', '<=', '=='].includes(cmp.op);
  if (direction === 'dec') return ['>', '>=', '=='].includes(cmp.op);
  return false;
}
