/**
 * Quarantined pre-cutover TypeScript graph validator.
 *
 * Test-only shadow for the 30-day differential confidence window. Production
 * must not import this file; graph semantics execute in Prolog.
 */

import type { Action, Choice, Diagnostic, Finding, TrajectoryNode, VariableDecl } from '../../src/types.ts';
import { CODES, END } from '../../src/types.ts';
import { tryConstEval, typeOf, varsIn } from '../../src/expr.ts';
import { analyzeGate, eventuallyFalse, type GateContext } from './gates.ts';
import { resolveTimebox } from '../../src/refs.ts';
import { renderFinding } from '../../src/diagnostics.ts';
import type { ParsedPlan } from '../../src/parser.ts';

interface Edge {
  from: string;
  to: string;
  choice: Choice | null; // null → automatic next step
  line: number;
}

/** Compose the semantic findings into user-facing diagnostics (compiler path). */
export function validatePlan(plan: ParsedPlan, diagnostics: Diagnostic[]): void {
  const priorErrors = diagnostics.some((d) => d.severity === 'error');
  for (const finding of analyzePlan(plan, { priorErrors })) {
    diagnostics.push(renderFinding(finding));
  }
}

/**
 * The semantic core. `priorErrors` marks lexical-layer failure (parse
 * diagnostics): reference checks still run, but graph analysis assumes a
 * closed graph and is skipped when anything upstream already failed.
 */
export function analyzePlan(plan: ParsedPlan, options: { priorErrors?: boolean } = {}): Finding[] {
  const { nodes, variables } = plan;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const findings: Finding[] = [];
  const error = (line: number | undefined, code: string, data: Finding['data'], variant?: string) =>
    findings.push({ severity: 'error', code, line, data, variant });
  const warn = (line: number | undefined, code: string, data: Finding['data'], variant?: string) =>
    findings.push({ severity: 'warning', code, line, data, variant });

  if (nodes.length === 0) {
    error(undefined, CODES.PARSE, {}, 'no-phases');
    return findings;
  }

  // --- Targets ---------------------------------------------------------------
  const targetCandidates = [...nodeIds, END];
  const checkTarget = (target: string, line: number, subject: string) => {
    if (target === END || nodeIds.has(target)) return;
    error(line, CODES.UNDEFINED_TARGET, { subject, target, candidates: targetCandidates });
  };
  if (plan.start && !nodeIds.has(plan.start)) {
    error(undefined, CODES.UNDEFINED_TARGET, { target: plan.start, candidates: [...nodeIds] }, 'start');
  }
  for (const node of nodes) {
    for (const choice of node.choices) checkTarget(choice.target, choice.line, `choice "${choice.label}"`);
    if (node.next) checkTarget(node.next.target, node.next.line, 'automatic next step');
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

  const varCandidates = Object.keys(variables);
  const usedVars = new Set<string>();
  const checkVars = (names: Set<string>, line: number, context: string) => {
    for (const name of names) {
      usedVars.add(name);
      if (!(name in variables)) {
        error(line, CODES.UNDEFINED_VARIABLE, { name, context, candidates: varCandidates });
      }
    }
  };
  for (const node of nodes) {
    for (const observation of node.observations) {
      usedVars.add(observation.var);
      if (!(observation.var in variables)) {
        error(observation.line, CODES.UNDEFINED_VARIABLE, {
          name: observation.var,
          context: `observation checkpoint "? ${observation.var}"`,
          candidates: varCandidates,
        });
      }
    }
    for (const action of node.actions) {
      usedVars.add(action.var);
      if (!(action.var in variables)) {
        error(action.line, CODES.UNDEFINED_VARIABLE, { name: action.var, candidates: varCandidates }, 'mutation');
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
      warn(decl.line, CODES.UNUSED_VARIABLE, { name });
    }
  }

  // --- Timeboxes need an alternative --------------------------------------
  // A timebox is evidence for taking an abandon door; with a single exit it
  // cannot change any outcome, so the speculative shape is incomplete.
  for (const node of nodes) {
    if (resolveTimebox(node.meta) === null) continue;
    if (node.choices.length + (node.next ? 1 : 0) < 2) {
      warn(node.line, CODES.TIMEBOX_WITHOUT_ALTERNATIVE, { id: node.id });
    }
  }

  // Bail out on unresolved references: graph analysis below assumes a closed graph.
  if (options.priorErrors || findings.some((f) => f.severity === 'error')) return findings;

  const gateCtx: GateContext = { variables, mutations };

  // Cycle membership over the unfiltered graph, so gate verdicts can tell a
  // loop-continue gate from an ordinary one regardless of which edge carries
  // the ~loop~ mark. False gates only ever remove edges, so a cycle found here
  // that a false gate would break still gets its structural error below.
  const allBySource = new Map<string, Edge[]>();
  for (const node of nodes) {
    const out: Edge[] = node.choices.map((c) => ({ from: node.id, to: c.target, choice: c, line: c.line }));
    if (node.next) out.push({ from: node.id, to: node.next.target, choice: null, line: node.next.line });
    allBySource.set(node.id, out);
  }
  const sccAll = tarjan(nodes.map((n) => n.id), allBySource);
  const onCycleWith = (from: string, to: string) =>
    from === to || (to !== END && sccAll.get(from) === sccAll.get(to));

  // --- Per-gate verdicts -----------------------------------------------------
  const falseGates = new Set<string>(); // choice ids provably never available
  const unverified = new Map<string, { choice: Choice }>();
  for (const node of nodes) {
    for (const choice of node.choices) {
      if (!choice.gate) continue;
      const verdict = analyzeGate(choice.gate, gateCtx);
      if (verdict.status === 'unsatisfiable') {
        falseGates.add(choice.id);
        warn(choice.line, CODES.CONSTANT_FALSE_GATE, { label: choice.label, reason: verdict.reason });
      } else if (verdict.status === 'unknown') {
        // A loop-continue gate that provably shuts eventually is a verified
        // bounded loop, not an unverified gate — whether or not this
        // particular edge carries the ~loop~ mark.
        if ((choice.loop || onCycleWith(node.id, choice.target)) &&
            eventuallyFalse(choice.gate, gateCtx)) continue;
        unverified.set(choice.id, { choice });
      }
    }
  }

  // --- Effective edges (excluding provably-false gates) ----------------------
  const bySource = new Map<string, Edge[]>();
  for (const node of nodes) {
    const out: Edge[] = [];
    for (const choice of node.choices) {
      if (falseGates.has(choice.id)) continue;
      out.push({ from: node.id, to: choice.target, choice, line: choice.line });
    }
    if (node.next) out.push({ from: node.id, to: node.next.target, choice: null, line: node.next.line });
    bySource.set(node.id, out);
  }

  // --- Dead ends -------------------------------------------------------------
  for (const node of nodes) {
    if ((bySource.get(node.id) ?? []).length === 0) {
      error(node.line, CODES.DEAD_END, { id: node.id });
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
      error(node.line, CODES.UNREACHABLE, { id: node.id, start });
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
            error(edge.line, CODES.UNDECLARED_CYCLE, { path });
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
        warn(choice.line, CODES.LOOP_ONCE_ONLY, { label: choice.label });
      }
      const scc = sccOf.get(node.id)!;
      const inCycle = cyclicSccs.has(scc) && sccOf.get(choice.target) === scc;
      if (!inCycle) {
        warn(choice.line, CODES.LOOP_NOT_A_CYCLE, { label: choice.label });
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
        error(choice.line,
          unsatExit ? CODES.LOOP_EXIT_UNSATISFIABLE : CODES.LOOP_WITHOUT_EXIT,
          { id: node.id });
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
        error(choice.line, CODES.LOOP_EXIT_UNSATISFIABLE, { id: node.id });
      } else {
        for (const exit of unknownExits) {
          if (exit.choice) warnedUnverified.add(exit.choice.id);
          warn(exit.line, CODES.UNVERIFIED_GATE,
            { source: exit.choice?.gate?.source ?? null }, 'loop-exit');
        }
      }
    }
  }

  // --- Remaining unverified gates (P0.4) -------------------------------------
  for (const { choice } of unverified.values()) {
    if (warnedUnverified.has(choice.id)) continue;
    warn(choice.line, CODES.UNVERIFIED_GATE, { source: choice.gate!.source, label: choice.label });
  }

  return findings;
}

function checkMutationTypes(
  action: Action,
  decl: VariableDecl,
  error: (line: number | undefined, code: string, data: Finding['data'], variant?: string) => void,
): void {
  if (action.op === '+=' || action.op === '-=') {
    if (decl.type !== 'number') {
      error(action.line, CODES.TYPE_MISMATCH,
        { op: action.op, var: action.var, type: decl.type }, 'op-non-number');
      return;
    }
    const value = tryConstEval(action.value);
    if (value !== undefined && typeof value !== 'number') {
      error(action.line, CODES.TYPE_MISMATCH,
        { op: action.op, valueType: typeOf(value) }, 'op-value-non-number');
    }
    return;
  }
  const value = tryConstEval(action.value);
  if (value !== undefined && typeOf(value) !== decl.type) {
    error(action.line, CODES.TYPE_MISMATCH,
      { valueType: typeOf(value), var: action.var, declType: decl.type }, 'assign-mismatch');
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
