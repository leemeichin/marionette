/**
 * Prolog fact emission: a parsed plan rendered as a logic fact base.
 *
 * The fact base is the input to `spec/rules/marionette.pl`, which restates the
 * structural validators as declarative rules (an independent oracle, diffed
 * against src/validate.ts in tests/oracle.test.ts) and doubles as a query
 * surface for interrogating a plan interactively:
 *
 *   marionette facts plan.mar > plan.pl
 *   swipl spec/rules/marionette.pl plan.pl
 *   ?- unattended_completion.
 *
 * Facts carry exactly what the validator consumes — nodes, edges, gates and
 * mutations as ASTs, declarations — plus source ordinals so order-sensitive
 * diagnostics can be reproduced.
 */

import type { Expr, Value } from './types.js';
import type { ParsedPlan } from './parser.js';
import { resolvePriority, resolveTimebox } from './refs.js';

/** Quote a string as a Prolog atom: 'it''s' style quoting is avoided in favour of backslash escapes. */
function atom(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Quote a string as a SWI-Prolog string literal. */
function str(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = String(n);
  // Prolog floats need a digit on both sides of the point and no bare "e5".
  return /^-?\d+\.\d+(e[+-]?\d+)?$/i.test(s) ? s : n.toExponential();
}

function value(v: Value): string {
  if (typeof v === 'number') return `num(${num(v)})`;
  if (typeof v === 'boolean') return `bool(${v})`;
  return `str(${str(v)})`;
}

const BIN_OPS: Record<string, string> = {
  '||': 'or', '&&': 'and', '==': 'eq', '!=': 'ne',
  '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
};

/** Render an expression AST as a ground Prolog term. */
export function exprTerm(e: Expr): string {
  switch (e.kind) {
    case 'lit': return `lit(${value(e.value)})`;
    case 'var': return `var(${atom(e.name)})`;
    case 'unary': return `un(${e.op === '!' ? 'not' : 'neg'}, ${exprTerm(e.operand)})`;
    case 'binary': return `bin(${BIN_OPS[e.op]}, ${exprTerm(e.left)}, ${exprTerm(e.right)})`;
  }
}

const ACTION_OPS: Record<string, string> = { '=': 'assign', '+=': 'inc', '-=': 'dec' };

/**
 * Emit the fact base for a parsed plan. The schema (documented in
 * spec/rules/README.md) is:
 *
 *   plan_start(Node).
 *   node(Node, Line, Ord).
 *   variable(Name, Type, Initial, Line).
 *   action(Node, Var, assign|inc|dec, Expr, Line).
 *   choice(Id, Node, Target, Line, Ord).      % Ord: global source order
 *   label(Id, Label).
 *   sticky(Id).  human(Id).  loop_marked(Id).
 *   gate(Id, Expr, Source).
 *   divert(Node, Target, Line).
 *   timebox(Node, Seconds).                   % valid # timebox: only
 *   priority(Node, critical|high|normal|low). % valid # priority: only
 */
export function emitFacts(plan: ParsedPlan): string {
  const lines: string[] = [
    ':- encoding(utf8).',
    '% Marionette fact base - generated, do not edit.',
    ':- discontiguous plan_start/1, node/3, variable/4, action/5, choice/5,',
    '   label/2, sticky/1, human/1, loop_marked/1, gate/3, divert/3,',
    '   timebox/2, priority/2.',
  ];
  if (plan.start) lines.push(`plan_start(${atom(plan.start)}).`);

  for (const [name, decl] of Object.entries(plan.variables)) {
    lines.push(`variable(${atom(name)}, ${decl.type}, ${value(decl.initial)}, ${decl.line}).`);
  }

  let choiceOrd = 0;
  plan.nodes.forEach((node, nodeOrd) => {
    lines.push(`node(${atom(node.id)}, ${node.line}, ${nodeOrd}).`);
    for (const action of node.actions) {
      lines.push(`action(${atom(node.id)}, ${atom(action.var)}, ${ACTION_OPS[action.op]}, ${exprTerm(action.value)}, ${action.line}).`);
    }
    for (const choice of node.choices) {
      lines.push(`choice(${atom(choice.id)}, ${atom(node.id)}, ${atom(choice.target)}, ${choice.line}, ${choiceOrd++}).`);
      lines.push(`label(${atom(choice.id)}, ${str(choice.label)}).`);
      if (choice.sticky) lines.push(`sticky(${atom(choice.id)}).`);
      if (choice.human) lines.push(`human(${atom(choice.id)}).`);
      if (choice.loop) lines.push(`loop_marked(${atom(choice.id)}).`);
      if (choice.gate) lines.push(`gate(${atom(choice.id)}, ${exprTerm(choice.gate.ast)}, ${str(choice.gate.source)}).`);
    }
    const timebox = resolveTimebox(node.meta);
    if (timebox) lines.push(`timebox(${atom(node.id)}, ${timebox.seconds}).`);
    const priority = resolvePriority(node.meta);
    if (priority) lines.push(`priority(${atom(node.id)}, ${priority}).`);
    if (node.divert) lines.push(`divert(${atom(node.id)}, ${atom(node.divert.target)}, ${node.divert.line}).`);
  });

  return lines.join('\n') + '\n';
}
