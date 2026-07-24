/**
 * Structural validation (P0.3) over a parsed plan:
 * undefined targets/variables, dead ends, unreachable phases, undeclared
 * cycles, loops without a satisfiable exit, plus gate verification warnings.
 */

import type { Action, Choice, Diagnostic, TrajectoryNode, VariableDecl } from './types.js';
import { CODES, END } from './types.js';
import { tryConstEval, typeOf, varsIn } from './expr.js';
import { analyzeGate, eventuallyFalse, type GateContext } from './gates.js';
import { resolveTimebox } from './refs.js';
import type { ParsedPlan } from './parser.js';
import { nearest } from './suggest.js';

interface Edge {
  from: string;
  to: string;
  choice: Choice | null; // null → divert
  line: number;
}

export function validatePlan(plan: ParsedPlan, diagnostics: Diagnostic[]): void {
  const { nodes, variables } = plan;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const error = (line: number | undefined, code: string, message: string, suggestion?: string) =>
    diagnostics.push({ severity: 'error', code, message, line, suggestion });
  const warn = (line: number | undefined, code: string, message: string, suggestion?: string) =>
    diagnostics.push({ severity: 'warning', code, message, line, suggestion });

  if (nodes.length === 0) {
    error(undefined, CODES.PARSE, 'plan has no phases', 'add at least one "=== phase ===" section');
    return;
  }

  // --- Targets ---------------------------------------------------------------
  const checkTarget = (target: string, line: number, kind: string) => {
    if (target === END || nodeIds.has(target)) return;
    const near = nearest(target, [...nodeIds, END]);
    error(line, CODES.UNDEFINED_TARGET, `${kind} targets undefined phase "${target}"`,
      near ? `did you mean "${near}"?` : `declare "=== ${target} ===" or divert to ${END}`);
  };
  if (plan.start && !nodeIds.has(plan.start)) {
    const near = nearest(plan.start, [...nodeIds]);
    error(undefined, CODES.UNDEFINED_TARGET, `start divert targets undefined phase "${plan.start}"`,
      near ? `did you mean "${near}"?` : undefined);
  }
  for (const node of nodes) {
    for (const choice of node.choices) checkTarget(choice.target, choice.line, `choice "${choice.label}"`);
    if (node.divert) checkTarget(node.divert.target, node.divert.line, 'divert');
  }

  // --- Variables -------------------------------------------------------------
  const mutations = new Map<string, Action[]>();
  for (const node of nodes) {
    for (const action of node.actions) {
      const list = mutations.get(action.var) ?? [];
      list.push(action);
      mutations.set(action.var, list);
    }
  }

  const usedVars = new Set<string>();
  const checkVars = (names: Set<string>, line: number, context: string) => {
    for (const name of names) {
      usedVars.add(name);
      if (!(name in variables)) {
        const near = nearest(name, Object.keys(variables));
        error(line, CODES.UNDEFINED_VARIABLE, `undefined variable "${name}" in ${context}`,
          near ? `did you mean "${near}"?` : `declare it in the preamble: VAR ${name} = ...`);
      }
    }
  };
  for (const node of nodes) {
    for (const action of node.actions) {
      usedVars.add(action.var);
      if (!(action.var in variables)) {
        const near = nearest(action.var, Object.keys(variables));
        error(action.line, CODES.UNDEFINED_VARIABLE, `mutation of undefined variable "${action.var}"`,
          near ? `did you mean "${near}"?` : `declare it in the preamble: VAR ${action.var} = ...`);
      } else {
        checkMutationTypes(action, variables[action.var], error);
      }
      checkVars(varsIn(action.value), action.line, `mutation of "${action.var}"`);
    }
    for (const choice of node.choices) {
      if (choice.gate) checkVars(varsIn(choice.gate.ast), choice.line, `gate {${choice.gate.source}}`);
    }
  }
  for (const [name, decl] of Object.entries(variables)) {
    if (!usedVars.has(name)) {
      warn(decl.line, CODES.UNUSED_VARIABLE, `variable "${name}" is declared but never used`);
    }
  }

  // --- Timeboxes need an alternative --------------------------------------
  // A timebox is evidence for taking an abandon door; with a single exit it
  // cannot change any outcome, so the speculative shape is incomplete.
  for (const node of nodes) {
    if (resolveTimebox(node.meta) === null) continue;
    if (node.choices.length + (node.divert ? 1 : 0) < 2) {
      warn(node.line, CODES.TIMEBOX_WITHOUT_ALTERNATIVE,
        `phase "${node.id}" has a timebox but only one exit: spending or not spending the budget leads to the same place`,
        'a speculative phase needs both a "worked" and an "abandon" door — or drop the timebox');
    }
  }

  // Bail out on unresolved references: graph analysis below assumes a closed graph.
  if (diagnostics.some((d) => d.severity === 'error')) return;

  const gateCtx: GateContext = { variables, mutations };

  // Cycle membership over the unfiltered graph, so gate verdicts can tell a
  // loop-continue gate from an ordinary one regardless of which edge carries
  // the ~loop~ mark. False gates only ever remove edges, so a cycle found here
  // that a false gate would break still gets its structural error below.
  const allBySource = new Map<string, Edge[]>();
  for (const node of nodes) {
    const out: Edge[] = node.choices.map((c) => ({ from: node.id, to: c.target, choice: c, line: c.line }));
    if (node.divert) out.push({ from: node.id, to: node.divert.target, choice: null, line: node.divert.line });
    allBySource.set(node.id, out);
  }
  const sccAll = tarjan(nodes.map((n) => n.id), allBySource);
  const onCycleWith = (from: string, to: string) =>
    from === to || (to !== END && sccAll.get(from) === sccAll.get(to));

  // --- Per-gate verdicts -----------------------------------------------------
  const falseGates = new Set<string>(); // choice ids provably never available
  const unverified = new Map<string, { choice: Choice; reason: string }>();
  for (const node of nodes) {
    for (const choice of node.choices) {
      if (!choice.gate) continue;
      const verdict = analyzeGate(choice.gate, gateCtx);
      if (verdict.status === 'unsatisfiable') {
        falseGates.add(choice.id);
        warn(choice.line, CODES.CONSTANT_FALSE_GATE,
          `choice "${choice.label}" can never be taken: ${verdict.reason}`,
          'remove the choice or fix the gate');
      } else if (verdict.status === 'unknown') {
        // A loop-continue gate that provably shuts eventually is a verified
        // bounded loop, not an unverified gate — whether or not this
        // particular edge carries the ~loop~ mark.
        if ((choice.loop || onCycleWith(node.id, choice.target)) &&
            eventuallyFalse(choice.gate, gateCtx)) continue;
        unverified.set(choice.id, { choice, reason: verdict.reason });
      }
    }
  }

  // --- Effective edges (excluding provably-false gates) ----------------------
  const edges: Edge[] = [];
  const bySource = new Map<string, Edge[]>();
  for (const node of nodes) {
    const out: Edge[] = [];
    for (const choice of node.choices) {
      if (falseGates.has(choice.id)) continue;
      out.push({ from: node.id, to: choice.target, choice, line: choice.line });
    }
    if (node.divert) out.push({ from: node.id, to: node.divert.target, choice: null, line: node.divert.line });
    bySource.set(node.id, out);
    edges.push(...out);
  }

  // --- Dead ends -------------------------------------------------------------
  for (const node of nodes) {
    if ((bySource.get(node.id) ?? []).length === 0) {
      error(node.line, CODES.DEAD_END, `phase "${node.id}" is a dead end: no choices and no divert`,
        `add a choice or divert (e.g. "-> ${END}") so every path has an exit`);
    }
  }

  // --- Reachability ----------------------------------------------------------
  const start = plan.start!;
  const reachable = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const edge of bySource.get(id) ?? []) {
      if (edge.to !== END && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      error(node.line, CODES.UNREACHABLE, `phase "${node.id}" is unreachable from "${start}"`,
        'divert or link a choice to it, or remove it');
    }
  }

  // --- Undeclared cycles (DFS back edges) ------------------------------------
  const state = new Map<string, 'active' | 'done'>();
  const stack: Edge[] = [];
  const reportedCycles = new Set<string>();
  const dfs = (id: string) => {
    state.set(id, 'active');
    for (const edge of bySource.get(id) ?? []) {
      if (edge.to === END) continue;
      const s = state.get(edge.to);
      if (s === 'active') {
        // Cycle: edges on the stack from edge.to back to id, plus this edge.
        const startIdx = stack.findIndex((e) => e.from === edge.to);
        const cycleEdges = [...stack.slice(startIdx === -1 ? stack.length : startIdx), edge];
        const declared = cycleEdges.some((e) => e.choice?.loop);
        if (!declared) {
          const path = [...cycleEdges.map((e) => e.from), edge.to].join(' -> ');
          if (!reportedCycles.has(path)) {
            reportedCycles.add(path);
            error(edge.line, CODES.UNDECLARED_CYCLE, `undeclared cycle: ${path}`,
              'cycles must be intentional: mark the returning choice with ~loop~');
          }
        }
        continue;
      }
      if (s === 'done') continue;
      stack.push(edge);
      dfs(edge.to);
      stack.pop();
    }
    state.set(id, 'done');
  };
  dfs(start);

  // --- Loop analysis (SCCs) --------------------------------------------------
  const sccOf = tarjan(nodes.map((n) => n.id), bySource);
  const cyclicSccs = new Map<number, string[]>();
  {
    const members = new Map<number, string[]>();
    for (const [id, scc] of sccOf) {
      const list = members.get(scc) ?? [];
      list.push(id);
      members.set(scc, list);
    }
    for (const [scc, ids] of members) {
      const selfLoop = ids.length === 1 &&
        (bySource.get(ids[0]) ?? []).some((e) => e.to === ids[0]);
      if (ids.length > 1 || selfLoop) cyclicSccs.set(scc, ids);
    }
  }

  const warnedUnverified = new Set<string>();
  const analysedSccs = new Set<number>();
  for (const node of nodes) {
    for (const choice of node.choices) {
      if (!choice.loop || falseGates.has(choice.id)) continue;
      if (!choice.sticky) {
        warn(choice.line, CODES.LOOP_ONCE_ONLY,
          `loop choice "${choice.label}" is once-only ("*") and can iterate at most once`,
          'use a sticky choice ("+") so the loop can be taken repeatedly');
      }
      const scc = sccOf.get(node.id)!;
      const inCycle = cyclicSccs.has(scc) && sccOf.get(choice.target) === scc;
      if (!inCycle) {
        warn(choice.line, CODES.LOOP_NOT_A_CYCLE,
          `choice "${choice.label}" is marked ~loop~ but does not close a cycle`,
          'remove ~loop~, or point the choice back into the loop');
        continue;
      }
      if (analysedSccs.has(scc)) continue;
      analysedSccs.add(scc);

      const members = new Set(cyclicSccs.get(scc)!);
      const scopeMutations = new Map<string, Action[]>();
      for (const id of members) {
        const n = nodes.find((x) => x.id === id)!;
        for (const action of n.actions) {
          const list = scopeMutations.get(action.var) ?? [];
          list.push(action);
          scopeMutations.set(action.var, list);
        }
      }
      const exits: Edge[] = [];
      for (const id of members) {
        for (const edge of bySource.get(id) ?? []) {
          if (edge.to === END || !members.has(edge.to)) exits.push(edge);
        }
      }
      if (exits.length === 0) {
        // Distinguish "no exit at all" from "exits exist but every gate is
        // provably unsatisfiable" (those edges were filtered out above).
        const unsatExit = [...members].some((id) => {
          const n = nodes.find((x) => x.id === id)!;
          return n.choices.some((c) => falseGates.has(c.id) &&
            (c.target === END || !members.has(c.target)));
        });
        if (unsatExit) {
          error(choice.line, CODES.LOOP_EXIT_UNSATISFIABLE,
            `potential infinite loop: no exit gate of the cycle through "${node.id}" is satisfiable`,
            'ensure at least one exit gate can become true (e.g. a monotonic counter), or remove its gate');
        } else {
          error(choice.line, CODES.LOOP_WITHOUT_EXIT,
            `potential infinite loop: the cycle through "${node.id}" has no exit path`,
            'add a sibling choice or divert that leaves the loop (e.g. a counter-gated exit or an @human decision)');
        }
        continue;
      }
      const exitCtx: GateContext = { variables, mutations, scopeMutations };
      let verified = false;
      let allUnsat = true;
      const unknownExits: Edge[] = [];
      for (const exit of exits) {
        const gate = exit.choice?.gate;
        if (!gate) { verified = true; allUnsat = false; continue; }
        const verdict = analyzeGate(gate, exitCtx);
        if (verdict.status === 'satisfiable') { verified = true; allUnsat = false; }
        else if (verdict.status === 'unknown') { allUnsat = false; unknownExits.push(exit); }
      }
      if (verified) continue;
      if (allUnsat) {
        error(choice.line, CODES.LOOP_EXIT_UNSATISFIABLE,
          `potential infinite loop: no exit gate of the cycle through "${node.id}" is satisfiable`,
          'ensure at least one exit gate can become true (e.g. a monotonic counter), or remove its gate');
      } else {
        for (const exit of unknownExits) {
          if (exit.choice) warnedUnverified.add(exit.choice.id);
          warn(exit.line, CODES.UNVERIFIED_GATE,
            `unverified gate — review manually: cannot statically verify loop exit {${exit.choice?.gate?.source}}`,
            'the compiler only verifies constant gates and monotonic counters; confirm this exit can occur');
        }
      }
    }
  }

  // --- Remaining unverified gates (P0.4) -------------------------------------
  for (const { choice } of unverified.values()) {
    if (warnedUnverified.has(choice.id)) continue;
    warn(choice.line, CODES.UNVERIFIED_GATE,
      `unverified gate — review manually: {${choice.gate!.source}} on choice "${choice.label}"`,
      'the compiler only verifies constant gates and monotonic counters');
  }
}

function checkMutationTypes(
  action: Action,
  decl: VariableDecl,
  error: (line: number | undefined, code: string, message: string, suggestion?: string) => void,
): void {
  if (action.op === '+=' || action.op === '-=') {
    if (decl.type !== 'number') {
      error(action.line, CODES.TYPE_MISMATCH,
        `"${action.op}" requires a number, but "${action.var}" is a ${decl.type}`);
      return;
    }
    const value = tryConstEval(action.value);
    if (value !== undefined && typeof value !== 'number') {
      error(action.line, CODES.TYPE_MISMATCH,
        `"${action.op}" requires a numeric value, got ${typeOf(value)}`);
    }
    return;
  }
  const value = tryConstEval(action.value);
  if (value !== undefined && typeOf(value) !== decl.type) {
    error(action.line, CODES.TYPE_MISMATCH,
      `cannot assign ${typeOf(value)} to "${action.var}" (declared ${decl.type})`);
  }
}

/** Tarjan strongly-connected components. Returns node id → SCC index. */
function tarjan(ids: string[], bySource: Map<string, Edge[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, number>();
  let counter = 0;
  let sccCount = 0;

  const strongConnect = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const edge of bySource.get(v) ?? []) {
      const w = edge.to;
      if (w === END || !bySource.has(w)) continue;
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        result.set(w, sccCount);
        if (w === v) break;
      }
      sccCount++;
    }
  };

  for (const id of ids) if (!index.has(id)) strongConnect(id);
  return result;
}

