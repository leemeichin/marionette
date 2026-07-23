/**
 * Plain-language plan summary (P0.6): a reviewer with no DSL knowledge should
 * understand the trajectory — decision points, loops, human gates, unverified
 * gates — plus the compiler's defect and warning report.
 */

import type { Diagnostic, PlanState, Trajectory } from './types.js';
import { CODES, END } from './types.js';

export interface SummarizeOptions {
  diagnostics?: Diagnostic[];
  state?: PlanState | null;
  file?: string;
}

export function summarize(trajectory: Trajectory, options: SummarizeOptions = {}): string {
  const { diagnostics = [], state } = options;
  const out: string[] = [];
  const nodes = trajectory.nodes;
  const choices = nodes.flatMap((n) => n.choices);
  const decisionPoints = nodes.filter((n) => n.choices.length >= 2);
  const humanChoices = choices.filter((c) => c.human);
  const loopChoices = choices.filter((c) => c.loop);
  const gated = choices.filter((c) => c.gate);
  const unverified = diagnostics.filter((d) => d.code === CODES.UNVERIFIED_GATE);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  out.push(`# Plan summary: ${options.file ?? trajectory.source.file}`);
  out.push('');
  out.push(`Starts at **${trajectory.start}**. ` +
    `${nodes.length} phase${s(nodes.length)}, ${decisionPoints.length} decision point${s(decisionPoints.length)} ` +
    `(phases with 2+ choices), ${choices.length} choice${s(choices.length)} overall.`);
  out.push('');
  out.push(`- **Human checkpoints:** ${humanChoices.length === 0 ? 'none — the agent can traverse the whole plan autonomously' :
    humanChoices.map((c) => `"${c.label}" (at ${c.id.split('#')[0]})`).join('; ')}`);
  out.push(`- **Declared loops:** ${loopChoices.length === 0 ? 'none' :
    loopChoices.map((c) => `${c.id.split('#')[0]} → ${c.target} ("${c.label}")`).join('; ')}`);
  out.push(`- **Gates:** ${gated.length} gated choice${s(gated.length)}, of which ${unverified.length} ` +
    `unverified (review manually)`);
  const vars = Object.entries(trajectory.variables);
  out.push(`- **Variables:** ${vars.length === 0 ? 'none' :
    vars.map(([name, d]) => `${name}: ${d.type} = ${JSON.stringify(d.initial)}`).join(', ')}`);
  out.push(`- **Contract hash:** \`${trajectory.hash.slice(0, 19)}…\``);
  out.push('');

  if (state) {
    out.push('## Traversal status');
    out.push('');
    if (state.status === 'completed') {
      out.push(`The plan is **completed** (reached ${END}) after ${state.log.length} step${s(state.log.length)}.`);
    } else {
      out.push(`Currently at **${state.current}** after ${state.log.length} step${s(state.log.length)}. ` +
        `Variables: ${Object.entries(state.variables).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') || 'none'}.`);
    }
    const decisions = state.log.filter((entry) => entry.choice !== null);
    if (decisions.length > 0) {
      out.push('');
      out.push('Decisions taken:');
      for (const entry of decisions) {
        out.push(`- ${entry.at} — **${entry.actor}** chose "${entry.label}" at ${entry.from} → ${entry.to}` +
          (entry.rationale ? ` — ${entry.rationale}` : ''));
      }
    }
    out.push('');
  }

  out.push('## Walkthrough');
  out.push('');
  for (const node of nodes) {
    out.push(`### ${node.id}${node.id === trajectory.start ? ' (start)' : ''}`);
    if (node.body) out.push(node.body);
    for (const action of node.actions) {
      out.push(`- on entry: \`${action.var} ${action.op} ${action.source}\``);
    }
    for (const choice of node.choices) {
      const attrs: string[] = [];
      if (choice.gate) attrs.push(`only if \`${choice.gate.source}\``);
      if (choice.human) attrs.push('**requires a human decision**');
      if (choice.loop) attrs.push('loops back');
      if (choice.sticky) attrs.push('repeatable');
      out.push(`- **${choice.label}** → ${choice.target}${attrs.length ? ` (${attrs.join('; ')})` : ''}`);
    }
    if (node.divert) out.push(`- otherwise → ${node.divert.target}`);
    out.push('');
  }

  out.push('## Compiler report');
  out.push('');
  if (errors.length === 0 && warnings.length === 0) {
    out.push('No defects, no warnings. The plan is structurally sound: every phase is reachable, every path has an exit, and all declared loops have a verified exit.');
  } else {
    out.push(`${errors.length} error${s(errors.length)}, ${warnings.length} warning${s(warnings.length)}.`);
    for (const d of diagnostics) {
      out.push(`- ${d.severity} [${d.code}]${d.line !== undefined ? ` (line ${d.line})` : ''}: ${d.message}`);
    }
  }
  out.push('');
  return out.join('\n');
}

function s(n: number): string {
  return n === 1 ? '' : 's';
}
